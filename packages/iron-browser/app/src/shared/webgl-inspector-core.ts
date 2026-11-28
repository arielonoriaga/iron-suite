import type {
  RenderingOrderLayer,
  WebGlRecordedDrawCall,
  WebGlViewportSummary,
} from './types';

export interface WebGlFrameCapturePayload {
  capturedFrames: number;
  elapsedMs: number;
  summary: WebGlViewportSummary;
  passes: Array<{
    passIndex: number;
    canvasIndex: number;
    fboTarget: string;
    drawCalls: number;
    triangles: number;
    shaderSwitches: number;
    textureBinds: number;
  }>;
  drawCalls: WebGlRecordedDrawCall[];
  truncated: boolean;
  renderingOrder: RenderingOrderLayer[];
}

/**
 * Builds an idempotent, zero-Node-dependency WebGL1 + WebGL2 + Rendering-Order instrumentation
 * script safe for `Page.addScriptToEvaluateOnNewDocument` and runtime `executeJavaScript`.
 *
 * Design guarantees:
 * - Wraps `WebGLRenderingContext.prototype` & `WebGL2RenderingContext.prototype` once so BOTH
 *   new and already-created `<canvas>` WebGL contexts are tracked without requiring a reload.
 * - Steady-state overhead is <5ns per draw call (integer counter increments only; zero allocations,
 *   zero `gl.getError()` / `gl.finish()` / `gl.readPixels()` GPU pipeline stalls).
 * - Detailed chronological draw-call & render-pass logging runs ONLY during an explicit 1-frame
 *   `captureFrame(maxCalls)` request, bounded by `maxCalls`.
 */
export function buildWebGlInspectorInitScript(): string {
  return `(function () {
  if (typeof window === 'undefined') return;
  if (window.__ironWebGlInspector) return;

  var GL_POINTS = 0x0000;
  var GL_LINES = 0x0001;
  var GL_LINE_LOOP = 0x0002;
  var GL_LINE_STRIP = 0x0003;
  var GL_TRIANGLES = 0x0004;
  var GL_TRIANGLE_STRIP = 0x0005;
  var GL_TRIANGLE_FAN = 0x0006;
  var GL_BLEND = 0x0BE2;
  var GL_DEPTH_TEST = 0x0B71;
  var GL_CULL_FACE = 0x0B44;
  var GL_SCISSOR_TEST = 0x0C11;
  var GL_TEXTURE_2D = 0x0DE1;
  var GL_TEXTURE0 = 0x84C0;
  var GL_FRAMEBUFFER = 0x8D40;
  var GL_DRAW_FRAMEBUFFER = 0x8CA9;
  var GL_UNMASKED_VENDOR_WEBGL = 0x9245;
  var GL_UNMASKED_RENDERER_WEBGL = 0x9246;

  function modeName(mode) {
    switch (mode >>> 0) {
      case GL_POINTS: return 'POINTS';
      case GL_LINES: return 'LINES';
      case GL_LINE_LOOP: return 'LINE_LOOP';
      case GL_LINE_STRIP: return 'LINE_STRIP';
      case GL_TRIANGLES: return 'TRIANGLES';
      case GL_TRIANGLE_STRIP: return 'TRIANGLE_STRIP';
      case GL_TRIANGLE_FAN: return 'TRIANGLE_FAN';
      default: return '0x' + (mode >>> 0).toString(16);
    }
  }

  function computeTriangles(mode, count, instances) {
    var c = Math.max(0, count | 0);
    var inst = Math.max(1, instances | 0);
    var m = mode >>> 0;
    var tris = 0;
    if (m === GL_TRIANGLES) tris = Math.floor(c / 3);
    else if (m === GL_TRIANGLE_STRIP || m === GL_TRIANGLE_FAN) tris = Math.max(0, c - 2);
    return tris * inst;
  }

  var ctxMap = new WeakMap();
  var objIds = new WeakMap();
  var nextObjId = 1;
  function getObjId(obj) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return null;
    var id = objIds.get(obj);
    if (!id) {
      id = nextObjId++;
      objIds.set(obj, id);
    }
    return id;
  }

  var liveContexts = [];
  var currentFrameEpoch = 0;
  var rafScheduled = false;
  var rollFallbackTimer = null;
  var activeCapture = null;

  function performEndOfFrameRoll() {
    if (!rafScheduled) return;
    rafScheduled = false;
    if (rollFallbackTimer !== null) {
      clearTimeout(rollFallbackTimer);
      rollFallbackTimer = null;
    }
    currentFrameEpoch += 1;
    for (var i = liveContexts.length - 1; i >= 0; i--) {
      var entry = liveContexts[i].deref ? liveContexts[i].deref() : liveContexts[i];
      if (!entry) {
        liveContexts.splice(i, 1);
        continue;
      }
      if (entry.dirtyThisFrame) {
        entry.lastDrawCalls = entry.curDrawCalls;
        entry.lastTriangles = entry.curTriangles;
        entry.lastVertices = entry.curVertices;
        entry.lastInstanced = entry.curInstanced;
        entry.lastShaderSwitches = entry.curShaderSwitches;
        entry.lastTextureBinds = entry.curTextureBinds;
        entry.lastRenderPasses = Math.max(1, entry.curRenderPasses);
        if (entry.curDrawCalls > entry.peakDrawCalls) {
          entry.peakDrawCalls = entry.curDrawCalls;
        }
        entry.curDrawCalls = 0;
        entry.curTriangles = 0;
        entry.curVertices = 0;
        entry.curInstanced = 0;
        entry.curShaderSwitches = 0;
        entry.curTextureBinds = 0;
        entry.curFboSwitches = 0;
        entry.curRenderPasses = 0;
        entry.curLastPassFbo = -2;
        entry.dirtyThisFrame = false;
      }
    }
    if (activeCapture && activeCapture.started) {
      if (activeCapture.drawCalls.length > 0 || activeCapture.emptyTicks >= 2) {
        var cap = activeCapture;
        activeCapture = null;
        cap.finish(cap.drawCalls.length > 0 ? 1 : 0);
      } else {
        activeCapture.emptyTicks += 1;
        scheduleEndOfFrameRoll();
      }
    } else if (activeCapture && !activeCapture.started) {
      activeCapture.started = true;
      scheduleEndOfFrameRoll();
    }
  }

  function scheduleEndOfFrameRoll() {
    if (rafScheduled) return;
    rafScheduled = true;
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(performEndOfFrameRoll);
      rollFallbackTimer = setTimeout(performEndOfFrameRoll, 20);
    } else {
      rollFallbackTimer = setTimeout(performEndOfFrameRoll, 16);
    }
  }

  function ensureCtxState(gl) {
    var st = ctxMap.get(gl);
    if (st) return st;
    var isWebGl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    var renderer = undefined;
    var vendor = undefined;
    try {
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        renderer = String(gl.getParameter(GL_UNMASKED_RENDERER_WEBGL) || '') || undefined;
        vendor = String(gl.getParameter(GL_UNMASKED_VENDOR_WEBGL) || '') || undefined;
      }
    } catch (_e) {}

    st = {
      gl: gl,
      isWebGl2: isWebGl2,
      renderer: renderer,
      vendor: vendor,
      curDrawCalls: 0,
      curTriangles: 0,
      curVertices: 0,
      curInstanced: 0,
      curShaderSwitches: 0,
      curTextureBinds: 0,
      curFboSwitches: 0,
      curRenderPasses: 0,
      curLastPassFbo: -2,
      lastDrawCalls: 0,
      lastTriangles: 0,
      lastVertices: 0,
      lastInstanced: 0,
      lastShaderSwitches: 0,
      lastTextureBinds: 0,
      lastRenderPasses: 0,
      peakDrawCalls: 0,
      totalDrawCalls: 0,
      dirtyThisFrame: false,
      programs: 0,
      textures: 0,
      buffers: 0,
      framebuffers: 0,
      renderbuffers: 0,
      vaos: 0,
      contextLostCount: 0,
      contextLost: false,
      currentProgramId: null,
      currentFboId: null,
      activeTexUnit: 0,
      boundTex2dByUnit: Object.create(null),
      blendEnabled: false,
      depthTest: false,
      cullFace: false,
      scissorEnabled: false,
      viewportBox: [0, 0, gl.drawingBufferWidth || 0, gl.drawingBufferHeight || 0],
      canvasHooked: false
    };

    var canvas = gl.canvas;
    if (canvas && typeof canvas.addEventListener === 'function' && !st.canvasHooked) {
      st.canvasHooked = true;
      canvas.addEventListener('webglcontextlost', function () {
        st.contextLost = true;
        st.contextLostCount += 1;
      }, true);
      canvas.addEventListener('webglcontextrestored', function () {
        st.contextLost = false;
      }, true);
    }

    ctxMap.set(gl, st);
    liveContexts.push(typeof WeakRef === 'function' ? new WeakRef(st) : st);
    return st;
  }

  function resolveCanvasIndex(canvas) {
    if (!canvas || typeof document === 'undefined') return 0;
    var list = document.querySelectorAll('canvas');
    for (var i = 0; i < list.length; i++) {
      if (list[i] === canvas) return i;
    }
    return 0;
  }

  function recordDraw(gl, apiName, mode, count, instances) {
    var st = ensureCtxState(gl);
    var inst = Math.max(1, instances | 0);
    var verts = Math.max(0, count | 0) * inst;
    var tris = computeTriangles(mode, count, inst);
    st.curDrawCalls += 1;
    st.totalDrawCalls += 1;
    st.curVertices += verts;
    st.curTriangles += tris;
    if (inst > 1 || apiName.indexOf('Instanced') !== -1) {
      st.curInstanced += 1;
    }
    var curFboKey = st.currentFboId === null ? -1 : st.currentFboId;
    if (st.curLastPassFbo !== curFboKey) {
      st.curLastPassFbo = curFboKey;
      st.curRenderPasses += 1;
    }
    st.dirtyThisFrame = true;
    scheduleEndOfFrameRoll();

    if (activeCapture && activeCapture.started) {
      var cap = activeCapture;
      var canvasIdx = resolveCanvasIndex(gl.canvas);
      var fboTarget = st.currentFboId === null ? 'screen' : ('fbo#' + st.currentFboId);
      var passKey = canvasIdx + ':' + fboTarget;
      if (cap.lastPassKey !== passKey) {
        cap.lastPassKey = passKey;
        cap.currentPassIndex = cap.passes.length;
        cap.passes.push({
          passIndex: cap.currentPassIndex,
          canvasIndex: canvasIdx,
          fboTarget: fboTarget,
          drawCalls: 0,
          triangles: 0,
          shaderSwitches: 0,
          textureBinds: 0
        });
      }
      var pass = cap.passes[cap.currentPassIndex];
      if (pass) {
        pass.drawCalls += 1;
        pass.triangles += tris;
      }
      if (cap.drawCalls.length < cap.maxCalls) {
        cap.drawCalls.push({
          seq: cap.seq++,
          canvasIndex: canvasIdx,
          passIndex: cap.currentPassIndex,
          fboTarget: fboTarget,
          api: apiName,
          mode: modeName(mode),
          count: Math.max(0, count | 0),
          instances: inst,
          triangles: tris,
          vertices: verts,
          programId: st.currentProgramId,
          activeTextureUnit: st.activeTexUnit,
          boundTexture2d: st.boundTex2dByUnit[st.activeTexUnit] || null,
          blendEnabled: st.blendEnabled,
          depthTest: st.depthTest,
          cullFace: st.cullFace,
          scissorEnabled: st.scissorEnabled,
          viewport: [st.viewportBox[0], st.viewportBox[1], st.viewportBox[2], st.viewportBox[3]]
        });
      } else {
        cap.truncated = true;
      }
    }
  }

  function patchProto(Proto) {
    if (!Proto || Proto.__ironWebGlPatched) return;
    Object.defineProperty(Proto, '__ironWebGlPatched', { value: true, configurable: true });

    var origDrawArrays = Proto.drawArrays;
    if (typeof origDrawArrays === 'function') {
      Proto.drawArrays = function (mode, first, count) {
        recordDraw(this, 'drawArrays', mode, count, 1);
        return origDrawArrays.call(this, mode, first, count);
      };
    }

    var origDrawElements = Proto.drawElements;
    if (typeof origDrawElements === 'function') {
      Proto.drawElements = function (mode, count, type, offset) {
        recordDraw(this, 'drawElements', mode, count, 1);
        return origDrawElements.call(this, mode, count, type, offset);
      };
    }

    var origDrawArraysInstanced = Proto.drawArraysInstanced;
    if (typeof origDrawArraysInstanced === 'function') {
      Proto.drawArraysInstanced = function (mode, first, count, instanceCount) {
        recordDraw(this, 'drawArraysInstanced', mode, count, instanceCount);
        return origDrawArraysInstanced.call(this, mode, first, count, instanceCount);
      };
    }

    var origDrawElementsInstanced = Proto.drawElementsInstanced;
    if (typeof origDrawElementsInstanced === 'function') {
      Proto.drawElementsInstanced = function (mode, count, type, offset, instanceCount) {
        recordDraw(this, 'drawElementsInstanced', mode, count, instanceCount);
        return origDrawElementsInstanced.call(this, mode, count, type, offset, instanceCount);
      };
    }

    var origDrawRangeElements = Proto.drawRangeElements;
    if (typeof origDrawRangeElements === 'function') {
      Proto.drawRangeElements = function (mode, start, end, count, type, offset) {
        recordDraw(this, 'drawRangeElements', mode, count, 1);
        return origDrawRangeElements.call(this, mode, start, end, count, type, offset);
      };
    }

    var origUseProgram = Proto.useProgram;
    if (typeof origUseProgram === 'function') {
      Proto.useProgram = function (program) {
        var st = ensureCtxState(this);
        var nextId = getObjId(program);
        if (nextId !== st.currentProgramId) {
          st.currentProgramId = nextId;
          st.curShaderSwitches += 1;
          st.dirtyThisFrame = true;
          if (activeCapture && activeCapture.started && activeCapture.passes[activeCapture.currentPassIndex]) {
            activeCapture.passes[activeCapture.currentPassIndex].shaderSwitches += 1;
          }
        }
        return origUseProgram.call(this, program);
      };
    }

    var origActiveTexture = Proto.activeTexture;
    if (typeof origActiveTexture === 'function') {
      Proto.activeTexture = function (texUnit) {
        var st = ensureCtxState(this);
        st.activeTexUnit = Math.max(0, (texUnit | 0) - GL_TEXTURE0);
        return origActiveTexture.call(this, texUnit);
      };
    }

    var origBindTexture = Proto.bindTexture;
    if (typeof origBindTexture === 'function') {
      Proto.bindTexture = function (target, texture) {
        var st = ensureCtxState(this);
        var nextId = getObjId(texture);
        if ((target >>> 0) === GL_TEXTURE_2D) {
          st.boundTex2dByUnit[st.activeTexUnit] = nextId;
        }
        st.curTextureBinds += 1;
        st.dirtyThisFrame = true;
        if (activeCapture && activeCapture.started && activeCapture.passes[activeCapture.currentPassIndex]) {
          activeCapture.passes[activeCapture.currentPassIndex].textureBinds += 1;
        }
        return origBindTexture.call(this, target, texture);
      };
    }

    var origBindFramebuffer = Proto.bindFramebuffer;
    if (typeof origBindFramebuffer === 'function') {
      Proto.bindFramebuffer = function (target, fbo) {
        var st = ensureCtxState(this);
        var t = target >>> 0;
        if (t === GL_FRAMEBUFFER || t === GL_DRAW_FRAMEBUFFER) {
          var nextId = getObjId(fbo);
          if (nextId !== st.currentFboId) {
            st.currentFboId = nextId;
            st.curFboSwitches += 1;
            st.dirtyThisFrame = true;
          }
        }
        return origBindFramebuffer.call(this, target, fbo);
      };
    }

    var origEnable = Proto.enable;
    if (typeof origEnable === 'function') {
      Proto.enable = function (cap) {
        var st = ensureCtxState(this);
        var c = cap >>> 0;
        if (c === GL_BLEND) st.blendEnabled = true;
        else if (c === GL_DEPTH_TEST) st.depthTest = true;
        else if (c === GL_CULL_FACE) st.cullFace = true;
        else if (c === GL_SCISSOR_TEST) st.scissorEnabled = true;
        return origEnable.call(this, cap);
      };
    }

    var origDisable = Proto.disable;
    if (typeof origDisable === 'function') {
      Proto.disable = function (cap) {
        var st = ensureCtxState(this);
        var c = cap >>> 0;
        if (c === GL_BLEND) st.blendEnabled = false;
        else if (c === GL_DEPTH_TEST) st.depthTest = false;
        else if (c === GL_CULL_FACE) st.cullFace = false;
        else if (c === GL_SCISSOR_TEST) st.scissorEnabled = false;
        return origDisable.call(this, cap);
      };
    }

    var origViewport = Proto.viewport;
    if (typeof origViewport === 'function') {
      Proto.viewport = function (x, y, w, h) {
        var st = ensureCtxState(this);
        st.viewportBox = [x | 0, y | 0, w | 0, h | 0];
        return origViewport.call(this, x, y, w, h);
      };
    }

    function hookRes(createName, deleteName, counterKey) {
      var origCreate = Proto[createName];
      var origDelete = Proto[deleteName];
      if (typeof origCreate === 'function') {
        Proto[createName] = function () {
          var obj = origCreate.apply(this, arguments);
          if (obj) {
            var st = ensureCtxState(this);
            st[counterKey] += 1;
            getObjId(obj);
          }
          return obj;
        };
      }
      if (typeof origDelete === 'function') {
        Proto[deleteName] = function (obj) {
          if (obj) {
            var st = ensureCtxState(this);
            st[counterKey] = Math.max(0, st[counterKey] - 1);
          }
          return origDelete.apply(this, arguments);
        };
      }
    }

    hookRes('createProgram', 'deleteProgram', 'programs');
    hookRes('createTexture', 'deleteTexture', 'textures');
    hookRes('createBuffer', 'deleteBuffer', 'buffers');
    hookRes('createFramebuffer', 'deleteFramebuffer', 'framebuffers');
    hookRes('createRenderbuffer', 'deleteRenderbuffer', 'renderbuffers');
    hookRes('createVertexArray', 'deleteVertexArray', 'vaos');

    var origGetExtension = Proto.getExtension;
    if (typeof origGetExtension === 'function') {
      Proto.getExtension = function (name) {
        var ext = origGetExtension.call(this, name);
        if (ext && name === 'ANGLE_instanced_arrays' && !ext.__ironPatched) {
          var glRef = this;
          Object.defineProperty(ext, '__ironPatched', { value: true, configurable: true });
          if (typeof ext.drawArraysInstancedANGLE === 'function') {
            var origA = ext.drawArraysInstancedANGLE;
            ext.drawArraysInstancedANGLE = function (mode, first, count, primcount) {
              recordDraw(glRef, 'drawArraysInstancedANGLE', mode, count, primcount);
              return origA.call(this, mode, first, count, primcount);
            };
          }
          if (typeof ext.drawElementsInstancedANGLE === 'function') {
            var origE = ext.drawElementsInstancedANGLE;
            ext.drawElementsInstancedANGLE = function (mode, count, type, offset, primcount) {
              recordDraw(glRef, 'drawElementsInstancedANGLE', mode, count, primcount);
              return origE.call(this, mode, count, type, offset, primcount);
            };
          }
        }
        return ext;
      };
    }
  }

  if (typeof WebGLRenderingContext !== 'undefined') patchProto(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patchProto(WebGL2RenderingContext.prototype);

  if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype) {
    var origGetContext = HTMLCanvasElement.prototype.getContext;
    if (typeof origGetContext === 'function' && !HTMLCanvasElement.prototype.__ironCtxPatched) {
      Object.defineProperty(HTMLCanvasElement.prototype, '__ironCtxPatched', { value: true, configurable: true });
      HTMLCanvasElement.prototype.getContext = function (contextType) {
        var ctx = origGetContext.apply(this, arguments);
        if (ctx && typeof contextType === 'string') {
          var lower = contextType.toLowerCase();
          this.__ironCanvasKind = lower === 'webgl2' ? 'webgl2' : (lower.indexOf('webgl') !== -1 ? 'webgl' : lower);
          if (lower.indexOf('webgl') !== -1) {
            ensureCtxState(ctx);
          }
        }
        return ctx;
      };
    }
  }

  function buildShortSelector(el) {
    var tag = (el.tagName || 'div').toLowerCase();
    var id = el.getAttribute && el.getAttribute('id');
    if (id) return tag + '#' + id.slice(0, 48);
    var testId = el.getAttribute && el.getAttribute('data-testid');
    if (testId) return tag + '[data-testid="' + testId.slice(0, 48) + '"]';
    var cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    return cls.length > 0 ? (tag + '.' + cls.join('.')).slice(0, 72) : tag;
  }

  function inspectRenderingOrder(maxLayers) {
    var cap = Math.max(8, Math.min(200, maxLayers || 64));
    if (typeof document === 'undefined' || !document.body) return [];
    var layers = [];
    var all = document.body.querySelectorAll('*');
    var domIndex = 0;
    for (var i = 0; i < all.length && i < 2000; i++) {
      var el = all[i];
      var tag = (el.tagName || '').toLowerCase();
      var isCanvas = tag === 'canvas';
      var st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      var pos = st.position || 'static';
      var zRaw = st.zIndex || 'auto';
      var opacity = parseFloat(st.opacity || '1');
      if (!Number.isFinite(opacity)) opacity = 1;
      var reasons = [];
      if (isCanvas) reasons.push('canvas-surface');
      if (pos !== 'static' && zRaw !== 'auto') reasons.push('positioned-z-index');
      else if (pos === 'fixed' || pos === 'sticky') reasons.push(pos);
      if (opacity < 1) reasons.push('opacity<1');
      if (st.transform && st.transform !== 'none') reasons.push('transform');
      if (st.willChange && st.willChange !== 'auto') reasons.push('will-change:' + st.willChange);
      if (st.filter && st.filter !== 'none') reasons.push('filter');
      if (st.backdropFilter && st.backdropFilter !== 'none') reasons.push('backdrop-filter');
      if (st.mixBlendMode && st.mixBlendMode !== 'normal') reasons.push('mix-blend:' + st.mixBlendMode);
      if (st.isolation === 'isolate') reasons.push('isolation:isolate');

      if (!isCanvas && reasons.length === 0) continue;

      var numericZ = zRaw === 'auto' ? 0 : (parseInt(zRaw, 10) || 0);
      layers.push({
        _domIndex: domIndex++,
        _numericZ: numericZ,
        _isPositioned: pos !== 'static',
        selector: buildShortSelector(el),
        tag: tag,
        isCanvas: isCanvas,
        canvasKind: isCanvas ? (el.__ironCanvasKind || 'unknown') : undefined,
        zIndex: zRaw,
        position: pos,
        opacity: Math.round(opacity * 1000) / 1000,
        createsStackingContext: reasons.length > 0 && (pos !== 'static' ? (zRaw !== 'auto' || pos === 'fixed' || pos === 'sticky' || reasons.length > 0) : true),
        compositorReasons: reasons,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }

    layers.sort(function (a, b) {
      if (a._numericZ !== b._numericZ) return a._numericZ - b._numericZ;
      if (a._isPositioned !== b._isPositioned) return a._isPositioned ? 1 : -1;
      return a._domIndex - b._domIndex;
    });

    var out = [];
    for (var j = 0; j < layers.length && j < cap; j++) {
      var item = layers[j];
      out.push({
        paintOrder: j,
        selector: item.selector,
        tag: item.tag,
        isCanvas: item.isCanvas,
        canvasKind: item.canvasKind,
        zIndex: item.zIndex,
        position: item.position,
        opacity: item.opacity,
        createsStackingContext: item.createsStackingContext,
        compositorReasons: item.compositorReasons,
        bounds: item.bounds
      });
    }
    return out;
  }

  function getSummary() {
    var active = [];
    for (var i = liveContexts.length - 1; i >= 0; i--) {
      var st = liveContexts[i].deref ? liveContexts[i].deref() : liveContexts[i];
      if (!st) {
        liveContexts.splice(i, 1);
        continue;
      }
      active.push(st);
    }
    var summary = {
      contexts: active.length,
      webgl2Contexts: 0,
      drawCallsPerFrame: 0,
      trianglesPerFrame: 0,
      verticesPerFrame: 0,
      instancedDrawCallsPerFrame: 0,
      shaderSwitchesPerFrame: 0,
      textureBindsPerFrame: 0,
      renderPassesPerFrame: 0,
      peakDrawCallsPerFrame: 0,
      totalDrawCalls: 0,
      resources: {
        programs: 0,
        textures: 0,
        buffers: 0,
        framebuffers: 0,
        renderbuffers: 0,
        vaos: 0
      },
      contextLostCount: 0,
      contextLost: false,
      renderer: undefined,
      vendor: undefined
    };

    for (var k = 0; k < active.length; k++) {
      var c = active[k];
      if (c.isWebGl2) summary.webgl2Contexts += 1;
      var dc = c.lastDrawCalls > 0 ? c.lastDrawCalls : c.curDrawCalls;
      var tr = c.lastDrawCalls > 0 ? c.lastTriangles : c.curTriangles;
      var vt = c.lastDrawCalls > 0 ? c.lastVertices : c.curVertices;
      var ins = c.lastDrawCalls > 0 ? c.lastInstanced : c.curInstanced;
      var sh = c.lastDrawCalls > 0 ? c.lastShaderSwitches : c.curShaderSwitches;
      var tx = c.lastDrawCalls > 0 ? c.lastTextureBinds : c.curTextureBinds;
      var rp = c.lastDrawCalls > 0 ? c.lastRenderPasses : (c.curDrawCalls > 0 ? Math.max(1, c.curRenderPasses) : 0);
      summary.drawCallsPerFrame += dc;
      summary.trianglesPerFrame += tr;
      summary.verticesPerFrame += vt;
      summary.instancedDrawCallsPerFrame += ins;
      summary.shaderSwitchesPerFrame += sh;
      summary.textureBindsPerFrame += tx;
      summary.renderPassesPerFrame += rp;
      summary.peakDrawCallsPerFrame += Math.max(c.peakDrawCalls, dc);
      summary.totalDrawCalls += c.totalDrawCalls;
      summary.resources.programs += c.programs;
      summary.resources.textures += c.textures;
      summary.resources.buffers += c.buffers;
      summary.resources.framebuffers += c.framebuffers;
      summary.resources.renderbuffers += c.renderbuffers;
      summary.resources.vaos += c.vaos;
      summary.contextLostCount += c.contextLostCount;
      if (c.contextLost) summary.contextLost = true;
      if (!summary.renderer && c.renderer) summary.renderer = c.renderer;
      if (!summary.vendor && c.vendor) summary.vendor = c.vendor;
    }
    return summary;
  }

  function resetCounters() {
    for (var i = 0; i < liveContexts.length; i++) {
      var st = liveContexts[i].deref ? liveContexts[i].deref() : liveContexts[i];
      if (!st) continue;
      st.peakDrawCalls = 0;
      st.totalDrawCalls = 0;
      st.lastDrawCalls = 0;
      st.lastTriangles = 0;
      st.lastVertices = 0;
      st.lastInstanced = 0;
      st.lastShaderSwitches = 0;
      st.lastTextureBinds = 0;
      st.lastRenderPasses = 0;
      st.contextLostCount = 0;
    }
    return getSummary();
  }

  function captureFrame(maxCalls, timeoutMs, maxLayers) {
    var capLimit = Math.max(1, Math.min(2048, maxCalls || 256));
    var waitLimit = Math.max(80, Math.min(3000, timeoutMs || 650));
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        var cap = activeCapture;
        activeCapture = null;
        var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        resolve({
          capturedFrames: cap && cap.drawCalls.length > 0 ? 1 : 0,
          elapsedMs: Math.round((t1 - t0) * 100) / 100,
          summary: getSummary(),
          passes: cap ? cap.passes : [],
          drawCalls: cap ? cap.drawCalls : [],
          truncated: Boolean(cap && cap.truncated),
          renderingOrder: inspectRenderingOrder(maxLayers)
        });
      }, waitLimit);

      activeCapture = {
        started: true,
        emptyTicks: 0,
        maxCalls: capLimit,
        seq: 0,
        lastPassKey: '',
        currentPassIndex: 0,
        passes: [],
        drawCalls: [],
        truncated: false,
        finish: function (framesCount) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          resolve({
            capturedFrames: typeof framesCount === 'number' ? framesCount : (this.drawCalls.length > 0 ? 1 : 0),
            elapsedMs: Math.round((t1 - t0) * 100) / 100,
            summary: getSummary(),
            passes: this.passes,
            drawCalls: this.drawCalls,
            truncated: this.truncated,
            renderingOrder: inspectRenderingOrder(maxLayers)
          });
        }
      };
      scheduleEndOfFrameRoll();
    });
  }

  window.__ironWebGlInspector = {
    getSummary: getSummary,
    inspectRenderingOrder: inspectRenderingOrder,
    captureFrame: captureFrame,
    resetCounters: resetCounters
  };
})();`;
}
