use std::process::Command;

#[test]
fn iron_term_binary_accepts_empty_socket_env_and_flag() {
    let bin = env!("CARGO_BIN_EXE_iron-term");

    let env_out = Command::new(bin)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("IRON_TERM_SOCKET", "")
        .arg("--help")
        .output()
        .expect("execute iron-term with empty IRON_TERM_SOCKET");
    assert!(
        env_out.status.success(),
        "IRON_TERM_SOCKET=\"\" failed (status {:?}): {}",
        env_out.status.code(),
        String::from_utf8_lossy(&env_out.stderr)
    );

    let flag_out = Command::new(bin)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .args(["--socket", "", "--help"])
        .output()
        .expect("execute iron-term with empty --socket");
    assert!(
        flag_out.status.success(),
        "--socket \"\" failed (status {:?}): {}",
        flag_out.status.code(),
        String::from_utf8_lossy(&flag_out.stderr)
    );

    let both_out = Command::new(bin)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("IRON_TERM_SOCKET", "")
        .args(["--socket", "   ", "--help"])
        .output()
        .expect("execute iron-term with empty env and whitespace flag");
    assert!(
        both_out.status.success(),
        "IRON_TERM_SOCKET=\"\" --socket \"   \" failed (status {:?}): {}",
        both_out.status.code(),
        String::from_utf8_lossy(&both_out.stderr)
    );
}
