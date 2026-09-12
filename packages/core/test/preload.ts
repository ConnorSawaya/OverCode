import os from "os"
import path from "path"
import fs from "fs/promises"

process.env.OVERCODE_DB = ":memory:"
process.env.OVERCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OVERCODE_DISABLE_MODELS_FETCH = "true"
// The developer machine may have a repository rooted above the OS temp
// directory. Keep temp fixtures from inheriting that repository while still
// allowing Git to discover repositories created inside the temp directory.
const testTemp = await fs.realpath(os.tmpdir())
process.env.GIT_CEILING_DIRECTORIES = [
  testTemp,
  path.join(os.homedir(), "AppData", "Local", "Temp"),
]
  .filter((value, index, values) => values.indexOf(value) === index)
  .map((value) => value.replaceAll("\\", "/"))
  .join(";")
