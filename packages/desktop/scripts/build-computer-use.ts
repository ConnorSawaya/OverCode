import { mkdir, rename, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export async function buildComputerUse() {
  if (process.platform !== "win32") {
    console.log("Skipping Windows computer-use helper on this platform")
    return
  }

  const root = resolve(import.meta.dir, "..")
  const source = resolve(root, "src/native/computer-use.cs")
  const directory = resolve(root, "resources/computer-use")
  const output = resolve(directory, "overcode-computer-use.exe")
  const temporary = resolve(directory, `overcode-computer-use.${process.pid}.exe`)
  const windows = process.env.SystemRoot ?? process.env.WINDIR
  if (!windows) throw new Error("SystemRoot is required to locate the .NET Framework compiler")

  const candidates = ["Framework64", "Framework"].map((framework) =>
    resolve(windows, "Microsoft.NET", framework, "v4.0.30319/csc.exe"),
  )
  const available = await Promise.all(candidates.map((path) => Bun.file(path).exists()))
  const compiler = candidates.find((_, index) => available[index])
  if (!compiler) throw new Error(`.NET Framework C# compiler not found: ${candidates.join(", ")}`)
  if (!(await Bun.file(source).exists())) throw new Error(`Computer-use helper source not found: ${source}`)

  await mkdir(directory, { recursive: true })
  // This directory contains only generated resources, including this ignore file.
  await Bun.write(resolve(directory, ".gitignore"), "*\n")
  try {
    const child = Bun.spawn(
      [
        compiler,
        "/nologo",
        "/target:exe",
        "/platform:anycpu",
        "/langversion:5",
        "/optimize+",
        "/warnaserror+",
        "/codepage:65001",
        `/out:${temporary}`,
        ...["System", "System.Core", "System.Drawing", "System.Windows.Forms", "System.Web.Extensions"].map(
          (name) => `/reference:${resolve(dirname(compiler), `${name}.dll`)}`,
        ),
        source,
      ],
      { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000, windowsHide: true },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Computer-use helper compilation failed (${code})\n${stdout}${stderr}`)
    const file = Bun.file(temporary)
    if (!(await file.exists()) || file.size < 1024 || (await file.slice(0, 2).text()) !== "MZ") {
      throw new Error(`Compiler did not produce a valid executable: ${temporary}\n${stdout}${stderr}`)
    }
    await rename(temporary, output)
    console.log(`Built Windows computer-use helper: ${output} (${Bun.file(output).size} bytes; ${compiler})`)
  } finally {
    await rm(temporary, { force: true })
  }
}

if (import.meta.main) await buildComputerUse()
