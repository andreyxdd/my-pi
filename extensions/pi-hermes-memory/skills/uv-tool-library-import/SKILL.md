---
name: "uv-tool-library-import"
description: "Fix Python ModuleNotFoundError when a package installed via `uv tool install` is not importable in scripts or other tools. Use when a CLI tool works but `from <pkg> import ...` fails."
version: 1
created: "2026-05-18"
updated: "2026-05-18"
---
## When to Use

- Package installed with `uv tool install <pkg>`
- CLI entry point works (`<command> --help` succeeds)
- Import fails in scripts or other tools: `ModuleNotFoundError: No module named '<pkg>'`
- Need to use the package programmatically (as a library), not just as a CLI

## Procedure

1. **Confirm the install method**
   ```bash
   uv tool list
   ```
   If the package appears under `Tools` (not `Project dependencies`), it was installed as an isolated tool.

2. **Check the tool's shebang / Python path**
   ```bash
   which <command>
   head -n1 $(which <command>)
   ```
   Example output:
   ```
   #!/Users/<user>/.local/share/uv/tools/<pkg>/bin/python
   ```
   This confirms the tool lives in its own venv, not your default Python environment.

3. **Choose a fix path**

   **Option A — Need library access in current project / default env:**
   ```bash
   uv pip install <pkg>
   ```
   This makes the package importable in your active environment.

   **Option B — Keep tool isolated, but need to run a script with it:**
   Use the tool's dedicated Python interpreter:
   ```bash
   ~/.local/share/uv/tools/<pkg>/bin/python -c "from <pkg> import ..."
   ```

   **Option C — Need the tool's env + extra packages:**
   Use that interpreter's pip:
   ```bash
   ~/.local/share/uv/tools/<pkg>/bin/python -m pip install <extra-dep>
   ```

4. **Verify the import works**
   ```bash
   python -c "from <pkg>.<module> import <thing>; print('OK')"
   ```

## Pitfalls

- **Do not mix `uv tool install` and `uv pip install` for the same need.** `uv tool install` creates isolated tool environments meant for CLI-only use. It does not add the package to your default Python path.
- **Virtualenv confusion:** If you are inside a project venv, `uv pip install` will install into that venv. If you are outside any venv, it installs into the default user environment. Confirm with:
  ```bash
  uv pip show <pkg>
  ```
- **Shebang drift:** After upgrading or reinstalling the tool, the uv tool venv path may change. Re-check `which <command>` if imports break again.

## Verification

- `python -c "import <pkg>"` exits 0
- `python -c "from <pkg>.<submodule> import <name>"` exits 0
- If calling the tool's own Python, `<tool-python> -c "import <pkg>"` exits 0