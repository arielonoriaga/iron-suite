use std::{
    collections::HashMap,
    ffi::{CStr, c_char, c_int, c_void},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::{Mutex, OnceLock},
};

use serde_json::json;

use crate::{
    DEFAULT_MAX_EVENTS_PER_TAB, PublishInput, QueryFilter, SessionStorageOpInput, TabEventBusCore,
    pty::{PtySpawnInput, pty_kill, pty_poll, pty_resize, pty_spawn, pty_write},
};

type NapiEnv = *mut c_void;
type NapiValue = *mut c_void;
type NapiCallbackInfo = *mut c_void;
type NapiCallback = unsafe extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue;

const NAPI_OK: c_int = 0;

struct NapiSymbols {
    get_cb_info: unsafe extern "C" fn(
        NapiEnv,
        NapiCallbackInfo,
        *mut usize,
        *mut NapiValue,
        *mut NapiValue,
        *mut *mut c_void,
    ) -> c_int,
    get_value_uint32: unsafe extern "C" fn(NapiEnv, NapiValue, *mut u32) -> c_int,
    get_value_double: unsafe extern "C" fn(NapiEnv, NapiValue, *mut f64) -> c_int,
    get_value_string_utf8:
        unsafe extern "C" fn(NapiEnv, NapiValue, *mut c_char, usize, *mut usize) -> c_int,
    create_uint32: unsafe extern "C" fn(NapiEnv, u32, *mut NapiValue) -> c_int,
    create_double: unsafe extern "C" fn(NapiEnv, f64, *mut NapiValue) -> c_int,
    get_boolean: unsafe extern "C" fn(NapiEnv, bool, *mut NapiValue) -> c_int,
    create_string_utf8:
        unsafe extern "C" fn(NapiEnv, *const c_char, usize, *mut NapiValue) -> c_int,
    create_function: unsafe extern "C" fn(
        NapiEnv,
        *const c_char,
        usize,
        NapiCallback,
        *mut c_void,
        *mut NapiValue,
    ) -> c_int,
    set_named_property:
        unsafe extern "C" fn(NapiEnv, NapiValue, *const c_char, NapiValue) -> c_int,
    throw_error: unsafe extern "C" fn(NapiEnv, *const c_char, *const c_char) -> c_int,
}

unsafe impl Send for NapiSymbols {}
unsafe impl Sync for NapiSymbols {}

static NAPI: OnceLock<Option<NapiSymbols>> = OnceLock::new();
static BUS_REGISTRY: OnceLock<Mutex<(u32, HashMap<u32, TabEventBusCore>)>> = OnceLock::new();

fn registry() -> &'static Mutex<(u32, HashMap<u32, TabEventBusCore>)> {
    BUS_REGISTRY.get_or_init(|| Mutex::new((1, HashMap::new())))
}

unsafe fn resolve_sym<T: Copy>(name: &CStr) -> Option<T> {
    let raw = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    if raw.is_null() {
        None
    } else {
        Some(unsafe { std::mem::transmute_copy(&raw) })
    }
}

fn api() -> Option<&'static NapiSymbols> {
    NAPI.get_or_init(|| unsafe {
        Some(NapiSymbols {
            get_cb_info: resolve_sym(c"napi_get_cb_info")?,
            get_value_uint32: resolve_sym(c"napi_get_value_uint32")?,
            get_value_double: resolve_sym(c"napi_get_value_double")?,
            get_value_string_utf8: resolve_sym(c"napi_get_value_string_utf8")?,
            create_uint32: resolve_sym(c"napi_create_uint32")?,
            create_double: resolve_sym(c"napi_create_double")?,
            get_boolean: resolve_sym(c"napi_get_boolean")?,
            create_string_utf8: resolve_sym(c"napi_create_string_utf8")?,
            create_function: resolve_sym(c"napi_create_function")?,
            set_named_property: resolve_sym(c"napi_set_named_property")?,
            throw_error: resolve_sym(c"napi_throw_error")?,
        })
    })
    .as_ref()
}

unsafe fn js_throw(api: &NapiSymbols, env: NapiEnv, msg: &CStr) -> NapiValue {
    unsafe {
        (api.throw_error)(env, ptr::null(), msg.as_ptr());
    }
    ptr::null_mut()
}

unsafe fn read_args<const N: usize>(
    api: &NapiSymbols,
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> Option<[NapiValue; N]> {
    let mut argc = N;
    let mut argv = [ptr::null_mut(); N];
    let st = unsafe {
        (api.get_cb_info)(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if st != NAPI_OK || argc < N {
        None
    } else {
        Some(argv)
    }
}

unsafe fn read_u32(api: &NapiSymbols, env: NapiEnv, val: NapiValue) -> Option<u32> {
    let mut out = 0u32;
    if unsafe { (api.get_value_uint32)(env, val, &mut out) } == NAPI_OK {
        Some(out)
    } else {
        None
    }
}

unsafe fn read_u64_from_number(api: &NapiSymbols, env: NapiEnv, val: NapiValue) -> Option<u64> {
    let mut out = 0.0f64;
    if unsafe { (api.get_value_double)(env, val, &mut out) } == NAPI_OK && out.is_finite() && out >= 0.0 {
        Some(out as u64)
    } else {
        None
    }
}

const MAX_NAPI_INPUT_STRING_BYTES: usize = 768 * 1024;

unsafe fn read_utf8(api: &NapiSymbols, env: NapiEnv, val: NapiValue) -> Option<String> {
    let mut len = 0usize;
    if unsafe { (api.get_value_string_utf8)(env, val, ptr::null_mut(), 0, &mut len) } != NAPI_OK {
        return None;
    }
    if len > MAX_NAPI_INPUT_STRING_BYTES {
        return None;
    }
    let mut buf = vec![0u8; len + 1];
    let mut written = 0usize;
    if unsafe {
        (api.get_value_string_utf8)(
            env,
            val,
            buf.as_mut_ptr().cast::<c_char>(),
            buf.len(),
            &mut written,
        )
    } != NAPI_OK
    {
        return None;
    }
    buf.truncate(written);
    String::from_utf8(buf).ok()
}

unsafe fn make_utf8(api: &NapiSymbols, env: NapiEnv, s: &str) -> NapiValue {
    let mut out: NapiValue = ptr::null_mut();
    let _ = unsafe {
        (api.create_string_utf8)(env, s.as_ptr().cast::<c_char>(), s.len(), &mut out)
    };
    out
}

unsafe fn make_f64(api: &NapiSymbols, env: NapiEnv, n: f64) -> NapiValue {
    let mut out: NapiValue = ptr::null_mut();
    let _ = unsafe { (api.create_double)(env, n, &mut out) };
    out
}

unsafe fn with_napi_guard<F>(env: NapiEnv, f: F) -> NapiValue
where
    F: FnOnce(&NapiSymbols) -> NapiValue,
{
    let Some(api) = api() else {
        return ptr::null_mut();
    };
    match catch_unwind(AssertUnwindSafe(|| f(api))) {
        Ok(val) => val,
        Err(_) => unsafe { js_throw(api, env, c"internal TabEventBus panic") },
    }
}

unsafe extern "C" fn napi_bus_create(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let cap = read_args::<1>(api, env, info)
                .and_then(|a| read_u32(api, env, a[0]))
                .map(|v| v as usize)
                .unwrap_or(DEFAULT_MAX_EVENTS_PER_TAB);
            let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            let id = guard.0;
            guard.0 = guard.0.wrapping_add(1).max(1);
            guard.1.insert(id, TabEventBusCore::new(cap));

            let mut out: NapiValue = ptr::null_mut();
            let _ = (api.create_uint32)(env, id, &mut out);
            out
        })
    }
}

unsafe extern "C" fn napi_bus_destroy(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([h_val]) = read_args::<1>(api, env, info) else {
                return js_throw(api, env, c"busDestroy(handle) requires 1 arg");
            };
            let Some(handle) = read_u32(api, env, h_val) else {
                return js_throw(api, env, c"handle must be uint32");
            };
            let existed = registry()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .1
                .remove(&handle)
                .is_some();
            let mut out: NapiValue = ptr::null_mut();
            let _ = (api.get_boolean)(env, existed, &mut out);
            out
        })
    }
}

unsafe extern "C" fn napi_bus_begin_gesture(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([h_val, tab_val, role_val, action_val, now_val]) =
                read_args::<5>(api, env, info)
            else {
                return js_throw(api, env, c"busBeginGesture requires 5 args");
            };
            let (Some(handle), Some(tab_id), Some(role), Some(action), Some(now_ms)) = (
                read_u32(api, env, h_val),
                read_utf8(api, env, tab_val),
                read_utf8(api, env, role_val),
                read_utf8(api, env, action_val),
                read_u64_from_number(api, env, now_val),
            ) else {
                return js_throw(api, env, c"invalid busBeginGesture arguments");
            };

            let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            let Some(bus) = guard.1.get_mut(&handle) else {
                return js_throw(api, env, c"unknown TabEventBus handle");
            };
            let seq = bus.begin_gesture(&tab_id, &role, &action, now_ms);
            make_f64(api, env, seq as f64)
        })
    }
}

unsafe extern "C" fn napi_bus_publish(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([h_val, json_val]) = read_args::<2>(api, env, info) else {
                return js_throw(api, env, c"busPublish requires 2 args");
            };
            let (Some(handle), Some(raw_json)) =
                (read_u32(api, env, h_val), read_utf8(api, env, json_val))
            else {
                return js_throw(api, env, c"invalid busPublish arguments");
            };
            let Ok(input) = serde_json::from_str::<PublishInput>(&raw_json) else {
                return js_throw(api, env, c"invalid PublishInput JSON");
            };

            let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            let Some(bus) = guard.1.get_mut(&handle) else {
                return js_throw(api, env, c"unknown TabEventBus handle");
            };
            let seq = bus.publish(input);
            make_f64(api, env, seq as f64)
        })
    }
}

unsafe extern "C" fn napi_bus_claim_effect(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([h_val, tab_val, role_val, cat_val, key_val, win_val, now_val]) =
                read_args::<7>(api, env, info)
            else {
                return js_throw(api, env, c"busClaimEffect requires 7 args");
            };
            let (
                Some(handle),
                Some(tab_id),
                Some(role),
                Some(category),
                Some(effect_key),
                Some(window_ms),
                Some(now_ms),
            ) = (
                read_u32(api, env, h_val),
                read_utf8(api, env, tab_val),
                read_utf8(api, env, role_val),
                read_utf8(api, env, cat_val),
                read_utf8(api, env, key_val),
                read_u64_from_number(api, env, win_val),
                read_u64_from_number(api, env, now_val),
            )
            else {
                return js_throw(api, env, c"invalid busClaimEffect arguments");
            };

            let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            let Some(bus) = guard.1.get_mut(&handle) else {
                return js_throw(api, env, c"unknown TabEventBus handle");
            };
            let outcome =
                bus.claim_effect(&tab_id, &role, &category, &effect_key, window_ms, now_ms);
            let encoded = serde_json::to_string(&outcome).unwrap_or_else(|_| "{}".to_string());
            make_utf8(api, env, &encoded)
        })
    }
}

unsafe extern "C" fn napi_bus_session_storage_op(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([h_val, json_val]) = read_args::<2>(api, env, info) else {
                return js_throw(api, env, c"busSessionStorageOp requires 2 args");
            };
            let (Some(handle), Some(raw_json)) =
                (read_u32(api, env, h_val), read_utf8(api, env, json_val))
            else {
                return make_utf8(
                    api,
                    env,
                    &json!({"ok": false, "changed": false, "error": "invalid input or quota exceeded"}).to_string(),
                );
            };
            let Ok(input) = serde_json::from_str::<SessionStorageOpInput>(&raw_json) else {
                return make_utf8(
                    api,
                    env,
                    &json!({"ok": false, "changed": false, "error": "malformed storage op json"})
                        .to_string(),
                );
            };

            let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            let Some(bus) = guard.1.get_mut(&handle) else {
                return js_throw(api, env, c"unknown TabEventBus handle");
            };
            let res = bus.session_storage_op(input);
            let encoded = serde_json::to_string(&res).unwrap_or_else(|_| "{}".to_string());
            make_utf8(api, env, &encoded)
        })
    }
}

unsafe extern "C" fn napi_bus_query(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([h_val, json_val]) = read_args::<2>(api, env, info) else {
                return js_throw(api, env, c"busQuery requires 2 args");
            };
            let (Some(handle), Some(raw_json)) =
                (read_u32(api, env, h_val), read_utf8(api, env, json_val))
            else {
                return js_throw(api, env, c"invalid busQuery arguments");
            };
            let filter = serde_json::from_str::<QueryFilter>(&raw_json).unwrap_or_default();

            let guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            let Some(bus) = guard.1.get(&handle) else {
                return js_throw(api, env, c"unknown TabEventBus handle");
            };
            let res = bus.query(&filter);
            let encoded = serde_json::to_string(&res).unwrap_or_else(|_| "{}".to_string());
            make_utf8(api, env, &encoded)
        })
    }
}

unsafe extern "C" fn napi_bus_clear_tab(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([h_val, tab_val]) = read_args::<2>(api, env, info) else {
                return js_throw(api, env, c"busClearTab requires 2 args");
            };
            let (Some(handle), Some(tab_id)) =
                (read_u32(api, env, h_val), read_utf8(api, env, tab_val))
            else {
                return js_throw(api, env, c"invalid busClearTab arguments");
            };

            let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
            let Some(bus) = guard.1.get_mut(&handle) else {
                return js_throw(api, env, c"unknown TabEventBus handle");
            };
            let removed = bus.clear_tab(&tab_id);
            let mut out: NapiValue = ptr::null_mut();
            let _ = (api.get_boolean)(env, removed, &mut out);
            out
        })
    }
}

unsafe extern "C" fn napi_pty_spawn(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([json_val]) = read_args::<1>(api, env, info) else {
                return js_throw(api, env, c"ptySpawn requires 1 arg");
            };
            let Some(json_str) = read_utf8(api, env, json_val) else {
                return js_throw(api, env, c"invalid ptySpawn payload");
            };
            let parsed: PtySpawnInput = match serde_json::from_str(&json_str) {
                Ok(v) => v,
                Err(e) => {
                    let out = json!({ "ok": false, "error": format!("invalid ptySpawn json: {e}") });
                    return make_utf8(api, env, &out.to_string());
                }
            };
            let res = pty_spawn(parsed);
            let serialized = serde_json::to_string(&res).unwrap_or_else(|_| {
                "{\"ok\":false,\"error\":\"serialize error\"}".to_string()
            });
            make_utf8(api, env, &serialized)
        })
    }
}

unsafe extern "C" fn napi_pty_write(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([id_val, data_val]) = read_args::<2>(api, env, info) else {
                return js_throw(api, env, c"ptyWrite requires 2 args");
            };
            let (Some(id), Some(data_b64)) =
                (read_u32(api, env, id_val), read_utf8(api, env, data_val))
            else {
                return js_throw(api, env, c"invalid ptyWrite arguments");
            };
            let res = pty_write(id, &data_b64);
            let serialized = serde_json::to_string(&res).unwrap_or_else(|_| {
                "{\"ok\":false,\"bytesWritten\":0,\"error\":\"serialize error\"}".to_string()
            });
            make_utf8(api, env, &serialized)
        })
    }
}

unsafe extern "C" fn napi_pty_resize(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([id_val, cols_val, rows_val]) = read_args::<3>(api, env, info) else {
                return js_throw(api, env, c"ptyResize requires 3 args");
            };
            let (Some(id), Some(cols), Some(rows)) = (
                read_u32(api, env, id_val),
                read_u32(api, env, cols_val),
                read_u32(api, env, rows_val),
            ) else {
                return js_throw(api, env, c"invalid ptyResize arguments");
            };
            let ok = pty_resize(id, cols.min(u16::MAX as u32) as u16, rows.min(u16::MAX as u32) as u16);
            let mut out: NapiValue = ptr::null_mut();
            let _ = (api.get_boolean)(env, ok, &mut out);
            out
        })
    }
}

unsafe extern "C" fn napi_pty_poll(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([id_val]) = read_args::<1>(api, env, info) else {
                return js_throw(api, env, c"ptyPoll requires 1 arg");
            };
            let Some(id) = read_u32(api, env, id_val) else {
                return js_throw(api, env, c"invalid ptyPoll argument");
            };
            let res = pty_poll(id);
            let serialized = serde_json::to_string(&res).unwrap_or_else(|_| {
                "{\"ok\":false,\"dataB64\":\"\",\"exited\":true,\"exitCode\":null,\"droppedBytes\":0}".to_string()
            });
            make_utf8(api, env, &serialized)
        })
    }
}

unsafe extern "C" fn napi_pty_kill(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        with_napi_guard(env, |api| {
            let Some([id_val]) = read_args::<1>(api, env, info) else {
                return js_throw(api, env, c"ptyKill requires 1 arg");
            };
            let Some(id) = read_u32(api, env, id_val) else {
                return js_throw(api, env, c"invalid ptyKill argument");
            };
            let ok = pty_kill(id);
            let mut out: NapiValue = ptr::null_mut();
            let _ = (api.get_boolean)(env, ok, &mut out);
            out
        })
    }
}

unsafe fn export_fn(
    api: &NapiSymbols,
    env: NapiEnv,
    exports: NapiValue,
    name: &CStr,
    cb: NapiCallback,
) {
    let mut fn_val: NapiValue = ptr::null_mut();
    let name_bytes = name.to_bytes();
    if unsafe {
        (api.create_function)(
            env,
            name.as_ptr(),
            name_bytes.len(),
            cb,
            ptr::null_mut(),
            &mut fn_val,
        )
    } == NAPI_OK
        && !fn_val.is_null()
    {
        unsafe {
            let _ = (api.set_named_property)(env, exports, name.as_ptr(), fn_val);
        }
    }
}

/// Registers the native `TabEventBus` functions onto the Node-API `exports` object.
///
/// # Safety
/// Called by Node.js, Electron, or Bun's N-API loader with valid `napi_env` and `napi_value` handles.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(
    env: NapiEnv,
    exports: NapiValue,
) -> NapiValue {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // Disable kernel pipe core-dump streaming by default unless IRON_BROWSER_CORE_DUMP=1 so
        // systemd-coredump never wedges a crashing 1.45 TB V8 address space in anon_pipe_write
        // while holding ctl.sock open (Crashpad still writes minidumps via ptrace).
        #[cfg(unix)]
        if std::env::var("IRON_BROWSER_CORE_DUMP").as_deref() != Ok("1") {
            unsafe {
                let mut cur = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::getrlimit(libc::RLIMIT_CORE, &mut cur) == 0 && cur.rlim_cur != 0 {
                    cur.rlim_cur = 0;
                    let _ = libc::setrlimit(libc::RLIMIT_CORE, &cur);
                }
            }
        }
        let Some(api) = api() else {
            return;
        };
        unsafe {
            export_fn(api, env, exports, c"busCreate", napi_bus_create);
            export_fn(api, env, exports, c"busDestroy", napi_bus_destroy);
            export_fn(api, env, exports, c"busBeginGesture", napi_bus_begin_gesture);
            export_fn(api, env, exports, c"busPublish", napi_bus_publish);
            export_fn(api, env, exports, c"busClaimEffect", napi_bus_claim_effect);
            export_fn(
                api,
                env,
                exports,
                c"busSessionStorageOp",
                napi_bus_session_storage_op,
            );
            export_fn(api, env, exports, c"busQuery", napi_bus_query);
            export_fn(api, env, exports, c"busClearTab", napi_bus_clear_tab);
            export_fn(api, env, exports, c"ptySpawn", napi_pty_spawn);
            export_fn(api, env, exports, c"ptyWrite", napi_pty_write);
            export_fn(api, env, exports, c"ptyResize", napi_pty_resize);
            export_fn(api, env, exports, c"ptyPoll", napi_pty_poll);
            export_fn(api, env, exports, c"ptyKill", napi_pty_kill);
        }
    }));
    exports
}
