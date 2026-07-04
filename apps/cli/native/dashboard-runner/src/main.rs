use std::env;
use std::ffi::OsString;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs as unix_fs;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};
use serde_json::{json, Value};

fn usage() -> ! {
    eprintln!("Usage: dashboard-runner <bundle|copy-self|install|start|run|verify> [options]");
    std::process::exit(2);
}

#[derive(Default)]
struct Options {
    bundle: Option<PathBuf>,
    target: Option<PathBuf>,
    dest: Option<PathBuf>,
    cli_root: Option<PathBuf>,
    server_root: Option<PathBuf>,
    monorepo_root: Option<PathBuf>,
    port: u16,
    project_root: Option<PathBuf>,
    qdrant_url: Option<String>,
    node: Option<PathBuf>,
    log: Option<PathBuf>,
    timeout_ms: u64,
}

fn parse_options(args: &[String]) -> Options {
    let mut opts = Options { port: 17321, timeout_ms: 240_000, ..Default::default() };
    let mut i = 0;
    while i < args.len() {
        let key = &args[i];
        let value = args.get(i + 1).cloned().unwrap_or_else(|| usage());
        match key.as_str() {
            "--bundle" => opts.bundle = Some(PathBuf::from(value)),
            "--target" => opts.target = Some(PathBuf::from(value)),
            "--dest" => opts.dest = Some(PathBuf::from(value)),
            "--cli-root" => opts.cli_root = Some(PathBuf::from(value)),
            "--server-root" => opts.server_root = Some(PathBuf::from(value)),
            "--monorepo-root" => opts.monorepo_root = Some(PathBuf::from(value)),
            "--port" => opts.port = value.parse().unwrap_or_else(|_| usage()),
            "--project-root" => opts.project_root = Some(PathBuf::from(value)),
            "--qdrant-url" => opts.qdrant_url = Some(value),
            "--node" => opts.node = Some(PathBuf::from(value)),
            "--log" => opts.log = Some(PathBuf::from(value)),
            "--timeout-ms" => opts.timeout_ms = value.parse().unwrap_or_else(|_| usage()),
            _ => usage(),
        }
        i += 2;
    }
    opts
}

fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    copy_dir_inner(src, dest, false)
}

fn copy_dir_materialized(src: &Path, dest: &Path) -> std::io::Result<()> {
    copy_dir_inner(src, dest, true)
}

fn copy_dir_inner(src: &Path, dest: &Path, materialize_symlinks: bool) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_inner(&from, &to, materialize_symlinks)?;
        } else if ty.is_file() {
            if let Some(parent) = to.parent() { fs::create_dir_all(parent)?; }
            fs::copy(&from, &to)?;
        } else if ty.is_symlink() {
            if materialize_symlinks { copy_symlink_target(&from, &to)?; }
            else { copy_symlink_or_target(&from, &to)?; }
        }
    }
    Ok(())
}

fn copy_symlink_target(from: &Path, to: &Path) -> std::io::Result<()> {
    let real = fs::canonicalize(from)?;
    if real.is_dir() { copy_dir_materialized(&real, to) } else {
        if let Some(parent) = to.parent() { fs::create_dir_all(parent)?; }
        fs::copy(&real, to).map(|_| ())
    }
}

#[cfg(unix)]
fn copy_symlink_or_target(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() { fs::create_dir_all(parent)?; }
    let target = fs::read_link(from)?;
    unix_fs::symlink(target, to)
}

#[cfg(windows)]
fn copy_symlink_or_target(from: &Path, to: &Path) -> std::io::Result<()> {
    copy_symlink_target(from, to)
}

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        if path.is_dir() { fs::remove_dir_all(path).map_err(|e| format!("remove {}: {e}", path.display()))?; }
        else { fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))?; }
    }
    Ok(())
}

fn ensure_node_module(node_modules: &Path, pkg_name: &str, root_pnpm_dir: &Path) -> Result<PathBuf, String> {
    let dest = node_modules.join(pkg_name);
    if dest.exists() || !root_pnpm_dir.exists() { return Ok(dest); }
    let prefix = format!("{}@", pkg_name.replace('/', "+"));
    for entry in fs::read_dir(root_pnpm_dir).map_err(|e| format!("read {}: {e}", root_pnpm_dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) { continue; }
        let src = entry.path().join("node_modules").join(pkg_name);
        if src.exists() {
            if let Some(parent) = dest.parent() { fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?; }
            copy_dir_materialized(&src, &dest).map_err(|e| format!("copy node module {}: {e}", pkg_name))?;
            return Ok(dest);
        }
    }
    Err(format!("missing node module {pkg_name} in {}", root_pnpm_dir.display()))
}

fn ensure_node_module_recursive(node_modules: &Path, pkg_name: &str, root_pnpm_dir: &Path, seen: &mut std::collections::HashSet<String>) -> Result<(), String> {
    if !seen.insert(pkg_name.to_string()) { return Ok(()); }
    let dest = ensure_node_module(node_modules, pkg_name, root_pnpm_dir)?;
    let package_json = dest.join("package.json");
    let Ok(text) = fs::read_to_string(package_json) else { return Ok(()); };
    let Ok(pkg) = serde_json::from_str::<Value>(&text) else { return Ok(()); };
    let Some(deps) = pkg.get("dependencies").and_then(|v| v.as_object()) else { return Ok(()); };
    for name in deps.keys() {
        if name.starts_with("@customize-agent/") { continue; }
        ensure_node_module_recursive(node_modules, name, root_pnpm_dir, seen)?;
    }
    Ok(())
}

fn sanitize_package_json(file: &Path, workspace_versions: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let Ok(text) = fs::read_to_string(file) else { return Ok(()); };
    let Ok(mut pkg) = serde_json::from_str::<Value>(&text) else { return Ok(()); };
    let mut modified = false;
    for field in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
        let Some(deps) = pkg.get_mut(field).and_then(|v| v.as_object_mut()) else { continue; };
        let keys: Vec<String> = deps.keys().cloned().collect();
        for name in keys {
            let Some(version) = deps.get(&name).and_then(|v| v.as_str()) else { continue; };
            if version.starts_with("workspace:") {
                if let Some(actual) = workspace_versions.get(&name) { deps.insert(name, json!(format!("^{}", actual))); }
                else { deps.remove(&name); }
                modified = true;
            }
        }
    }
    if modified {
        fs::write(file, serde_json::to_string_pretty(&pkg).map_err(|e| e.to_string())? + "\n").map_err(|e| format!("write {}: {e}", file.display()))?;
    }
    Ok(())
}

fn walk_package_json(dir: &Path, workspace_versions: &std::collections::HashMap<String, String>) -> Result<(), String> {
    if !dir.exists() { return Ok(()); }
    for entry in fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "node_modules" || name == ".pnpm" { continue; }
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() { walk_package_json(&path, workspace_versions)?; }
        else if ty.is_file() && name == "package.json" { sanitize_package_json(&path, workspace_versions)?; }
    }
    Ok(())
}

fn patch_server_js(path: &Path) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let content = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let patched = content.replace("process.chdir(__dirname);", "// process.chdir removed by dashboard-runner to prevent file locking")
        .replace("process.chdir(__dirname)", "// process.chdir removed by dashboard-runner to prevent file locking");
    fs::write(path, patched).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

fn bundle(opts: Options) -> Result<(), String> {
    let cli_root = opts.cli_root.as_ref().ok_or("missing --cli-root")?;
    let server_root = opts.server_root.as_ref().ok_or("missing --server-root")?;
    let monorepo_root = opts.monorepo_root.as_ref().ok_or("missing --monorepo-root")?;
    let standalone = server_root.join(".next").join("standalone");
    if !standalone.exists() { return Err(format!("standalone output not found: {}", standalone.display())); }
    let dest = cli_root.join("dist").join("server-bundle");
    remove_if_exists(&dest)?;
    copy_dir_materialized(&standalone, &dest).map_err(|e| format!("copy standalone: {e}"))?;

    let packages_src = monorepo_root.join("packages");
    let packages_dest = dest.join("packages");
    remove_if_exists(&packages_dest)?;
    fs::create_dir_all(&packages_dest).map_err(|e| format!("create packages: {e}"))?;
    let vendor_modules = dest.join("vendor_modules");
    let scoped_vendor = vendor_modules.join("@customize-agent");
    let cli_scoped_modules = cli_root.join("dist").join("node_modules").join("@customize-agent");
    remove_if_exists(&cli_scoped_modules)?;
    for name in ["engine", "knowledge", "llm", "memory", "runtime", "search", "tools", "types"] {
        let src = packages_src.join(name);
        if src.exists() {
            let cli_module_dest = cli_scoped_modules.join(name);
            remove_if_exists(&cli_module_dest)?;
            copy_dir(&src, &cli_module_dest).map_err(|e| format!("copy cli package {name}: {e}"))?;
        }
    }
    for name in ["knowledge", "llm", "runtime", "types"] {
        let src = packages_src.join(name);
        if src.exists() {
            let package_dest = packages_dest.join(name);
            let runtime_dest = scoped_vendor.join(name);
            let standalone_dest = dest.join("apps").join("server").join("node_modules").join("@customize-agent").join(name);
            remove_if_exists(&package_dest)?;
            remove_if_exists(&runtime_dest)?;
            remove_if_exists(&standalone_dest)?;
            copy_dir(&src, &package_dest).map_err(|e| format!("copy package {name}: {e}"))?;
            copy_dir(&src, &runtime_dest).map_err(|e| format!("copy runtime package {name}: {e}"))?;
            copy_dir(&src, &standalone_dest).map_err(|e| format!("copy standalone package {name}: {e}"))?;
        }
    }

    let pnpm_root = monorepo_root.join("node_modules").join(".pnpm");
    let mut seen = std::collections::HashSet::new();
    for name in [
        "next",
        "react",
        "react-dom",
        "next-themes",
        "styled-jsx",
        "@napi-rs/canvas",
        "better-sqlite3",
        "bindings",
        "file-uri-to-path",
        "jszip",
        "mammoth",
        "pdf-parse",
        "pdfjs-dist",
        "tesseract.js",
        "xlsx",
        "fast-glob",
    ] {
        ensure_node_module_recursive(&vendor_modules, name, &pnpm_root, &mut seen)?;
    }

    let mut deps = serde_json::Map::new();
    for pkg_file in [server_root.join("package.json"), packages_src.join("knowledge/package.json"), packages_src.join("llm/package.json"), packages_src.join("runtime/package.json")] {
        let Ok(text) = fs::read_to_string(pkg_file) else { continue; };
        let Ok(pkg) = serde_json::from_str::<Value>(&text) else { continue; };
        if let Some(obj) = pkg.get("dependencies").and_then(|v| v.as_object()) {
            for (name, version) in obj {
                if !name.starts_with("@customize-agent/") && !deps.contains_key(name) { deps.insert(name.clone(), version.clone()); }
            }
        }
    }
    fs::write(dest.join("package.json"), serde_json::to_string_pretty(&json!({"name":"customize-agent-server","private":true,"description":"Bundled server runtime for customize-agent","dependencies":deps})).map_err(|e| e.to_string())? + "\n").map_err(|e| format!("write server package.json: {e}"))?;

    let mut workspace_versions = std::collections::HashMap::new();
    for entry in fs::read_dir(&packages_src).map_err(|e| format!("read packages: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file = entry.path().join("package.json");
        let Ok(text) = fs::read_to_string(file) else { continue; };
        let Ok(pkg) = serde_json::from_str::<Value>(&text) else { continue; };
        if let (Some(name), Some(version)) = (pkg.get("name").and_then(|v| v.as_str()), pkg.get("version").and_then(|v| v.as_str())) {
            workspace_versions.insert(name.to_string(), version.to_string());
        }
    }
    walk_package_json(&dest, &workspace_versions)?;

    let server_dest = dest.join("apps").join("server");
    let static_dir = server_root.join(".next").join("static");
    if static_dir.exists() { copy_dir(&static_dir, &server_dest.join(".next").join("static")).map_err(|e| format!("copy static: {e}"))?; }
    let public_dir = server_root.join("public");
    if public_dir.exists() { copy_dir(&public_dir, &server_dest.join("public")).map_err(|e| format!("copy public: {e}"))?; }
    patch_server_js(&server_dest.join("server.js"))?;
    fs::write(dest.join(".dashboard-bundled"), "").map_err(|e| format!("write marker: {e}"))?;
    println!("[dashboard-runner] Server bundle ready: {}", dest.display());
    Ok(())
}

fn copy_self(dest: &Path) -> Result<(), String> {
    let mut final_dest = dest.to_path_buf();
    if cfg!(windows) && final_dest.extension().is_none() {
        final_dest.set_extension("exe");
    }
    if let Some(parent) = final_dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let current = env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    fs::copy(&current, &final_dest).map_err(|e| format!("copy {} -> {}: {e}", current.display(), final_dest.display()))?;
    Ok(())
}

fn install(bundle: &Path, target: &Path) -> Result<(), String> {
    let bundle_build = bundle.join("apps").join("server").join(".next").join("BUILD_ID");
    let target_build = target.join("apps").join("server").join(".next").join("BUILD_ID");
    let bundle_id = read_trimmed(&bundle_build).ok_or_else(|| format!("missing {}", bundle_build.display()))?;
    let target_id = read_trimmed(&target_build).unwrap_or_default();
    if bundle_id != target_id {
        if target.exists() { fs::remove_dir_all(target).map_err(|e| format!("remove {}: {e}", target.display()))?; }
        copy_dir(bundle, target).map_err(|e| format!("copy {} -> {}: {e}", bundle.display(), target.display()))?;
    }
    let vendor = target.join("vendor_modules");
    let node_modules = target.join("node_modules");
    if vendor.exists() {
        if node_modules.exists() { fs::remove_dir_all(&node_modules).map_err(|e| format!("remove {}: {e}", node_modules.display()))?; }
        copy_dir(&vendor, &node_modules).map_err(|e| format!("copy vendor_modules: {e}"))?;
    }
    Ok(())
}

fn http_get(port: u16, path: &str, timeout: Duration) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), timeout).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let _ = stream.shutdown(Shutdown::Write);
    let mut buf = String::new();
    stream.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    let status = buf.lines().next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok((status, buf))
}

fn verify(port: u16, timeout_ms: u64) -> Result<(), String> {
    let paths = [
        "/api/health",
        "/overview",
        "/api/config/providers",
        "/api/config/models",
        "/api/kb/features",
        "/api/system/stats",
    ];
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut last = String::new();
    while Instant::now() < deadline {
        let mut rows = Vec::new();
        let mut ready = true;
        for path in paths {
            match http_get(port, path, Duration::from_secs(5)) {
                Ok((status, body)) if status < 500 => rows.push(format!("{path}={status}:{}", body.lines().last().unwrap_or_default())),
                Ok((status, body)) => {
                    ready = false;
                    rows.push(format!("{path}={status}:{}", body.lines().last().unwrap_or_default()));
                }
                Err(error) => {
                    ready = false;
                    rows.push(format!("{path}=error:{error}"));
                }
            }
        }
        last = rows.join("; ");
        if ready { return Ok(()); }
        sleep(Duration::from_millis(500));
    }
    Err(format!("dashboard verify timeout: {last}"))
}

fn spawn_server(opts: &Options) -> Result<Child, String> {
    let target = opts.target.as_ref().ok_or("missing --target")?;
    let server = target.join("apps").join("server").join("server.js");
    let node = opts.node.clone().unwrap_or_else(|| PathBuf::from("node"));
    let log_path = opts.log.clone().unwrap_or_else(|| target.join("dashboard.log"));
    if let Some(parent) = log_path.parent() { fs::create_dir_all(parent).map_err(|e| format!("create log dir: {e}"))?; }
    let out = fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| format!("open log {}: {e}", log_path.display()))?;
    let err = out.try_clone().map_err(|e| format!("clone log fd: {e}"))?;
    let path_sep = if cfg!(windows) { ";" } else { ":" };
    let node_path = target.join("node_modules");
    let mut cmd = Command::new(node);
    cmd.arg(server)
        .current_dir(target)
        .env("PORT", opts.port.to_string())
        .env("NODE_ENV", "production")
        .env("CUSTOMIZE_PROJECT_ROOT", opts.project_root.as_ref().unwrap_or(target))
        .env("QDRANT_URL", opts.qdrant_url.as_deref().unwrap_or("http://127.0.0.1:6333"))
        .env("NODE_PATH", append_node_path(node_path.into_os_string(), path_sep));
    if let Some(disable_ocr) = env::var_os("CUSTOMIZE_AGENT_DISABLE_OCR") {
        cmd.env("CUSTOMIZE_AGENT_DISABLE_OCR", disable_ocr);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    cmd.spawn().map_err(|e| format!("spawn dashboard: {e}"))
}

fn run(opts: Options) -> Result<(), String> {
    if let (Some(bundle), Some(target)) = (&opts.bundle, &opts.target) {
        install(bundle, target)?;
    }
    let mut child = spawn_server(&opts)?;
    match verify(opts.port, opts.timeout_ms) {
        Ok(()) => {
            let _ = child.kill();
            let _ = child.wait();
            Ok(())
        }
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(e)
        }
    }
}

fn start(opts: Options) -> Result<(), String> {
    if let (Some(bundle), Some(target)) = (&opts.bundle, &opts.target) {
        install(bundle, target)?;
    }
    let child = spawn_server(&opts)?;
    println!("pid={}", child.id());
    verify(opts.port, opts.timeout_ms)
}

fn append_node_path(first: OsString, sep: &str) -> OsString {
    match env::var_os("NODE_PATH") {
        Some(existing) if !existing.is_empty() => {
            let mut s = first;
            s.push(sep);
            s.push(existing);
            s
        }
        _ => first,
    }
}

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() { usage(); }
    let cmd = args.remove(0);
    let opts = parse_options(&args);
    let result = match cmd.as_str() {
        "bundle" => bundle(opts),
        "copy-self" => copy_self(opts.dest.as_ref().unwrap_or_else(|| usage())),
        "install" => install(opts.bundle.as_ref().unwrap_or_else(|| usage()), opts.target.as_ref().unwrap_or_else(|| usage())),
        "verify" => verify(opts.port, opts.timeout_ms),
        "start" => start(opts),
        "run" => run(opts),
        _ => usage(),
    };
    if let Err(e) = result {
        eprintln!("dashboard-runner: {e}");
        std::process::exit(1);
    }
}
