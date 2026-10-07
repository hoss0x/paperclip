//! Private OS-boundary handoff. exec replaces this helper; it is not a supervisor.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Invocation {
    command: String,
    args: Vec<String>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    identity_file: PathBuf,
}

#[cfg(unix)]
fn read_invocation(file: &std::path::Path) -> Result<Invocation, ()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(file)
        .map_err(|_| ())?;
    let metadata = source.metadata().map_err(|_| ())?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o777 != 0o600 {
        return Err(());
    }
    let mut content = Vec::new();
    Read::by_ref(&mut source)
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut content)
        .map_err(|_| ())?;
    if content.len() > 16 * 1024 * 1024 {
        return Err(());
    }
    let invocation: Invocation = serde_json::from_slice(&content).map_err(|_| ())?;
    if invocation.command.is_empty()
        || !invocation.cwd.is_absolute()
        || invocation.identity_file.parent() != file.parent()
        || invocation
            .identity_file
            .file_name()
            .and_then(|name| name.to_str())
            != Some("worker.pid")
    {
        return Err(());
    }
    Ok(invocation)
}

#[cfg(unix)]
pub fn execute(file: &std::path::Path) -> Result<(), ()> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::process::CommandExt;
    let invocation = read_invocation(file)?;
    fs::remove_file(file).map_err(|_| ())?;
    std::env::set_current_dir(&invocation.cwd).map_err(|_| ())?;
    let mut identity = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(&invocation.identity_file)
        .map_err(|_| ())?;
    write!(identity, "{}", std::process::id()).map_err(|_| ())?;
    drop(identity);
    // Preserve inherited provider, executable and credential-fence descriptors.
    // Do not print the invocation or any OS error that could include arguments.
    let _error = std::process::Command::new(&invocation.command)
        .args(&invocation.args)
        .env_clear()
        .envs(&invocation.env)
        .exec();
    Err(())
}

#[cfg(not(unix))]
pub fn execute(_file: &std::path::Path) -> Result<(), ()> {
    Err(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn rejects_public_or_redirected_invocations() {
        let directory = std::env::var_os("PAPERCLIP_SCRATCH_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("resource-exec-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let file = directory.join("invocation.json");
        let payload = serde_json::json!({ "command": "/bin/true", "args": [], "cwd": "/",
            "env": {}, "identityFile": directory.join("worker.pid") });
        fs::write(&file, payload.to_string()).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_invocation(&file).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_invocation(&file).is_ok());
        let link = directory.join("link.json");
        symlink(&file, &link).unwrap();
        assert!(read_invocation(&link).is_err());
        // Modify the known field without accepting a path outside this directory.
        let mut outside = payload.clone();
        outside["identityFile"] = serde_json::json!("/worker.pid");
        fs::write(&file, outside.to_string()).unwrap();
        assert!(read_invocation(&file).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
