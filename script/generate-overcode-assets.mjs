import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const brandDir = path.join(root, "packages/console/app/src/asset/brand")
const landerDir = path.join(root, "packages/console/app/src/asset/lander")
const publicBrandDir = path.join(root, "packages/console/app/public")

const styles = {
  light: { primary: "#656363", shadow: "#CFCECD", final: "#211E1E" },
  dark: { primary: "#B7B1B1", shadow: "#4B4646", final: "#F1ECEC" },
  simpleLight: { primary: "#000000", shadow: "#000000", final: "#000000", simple: true },
  simpleDark: { primary: "#FFFFFF", shadow: "#FFFFFF", final: "#FFFFFF", simple: true },
  poster: { primary: "#373535", shadow: "#171515", final: "#373535" },
}

const glyphPaths = {
  o: {
    shadow: "M18 30H6V18H18V30Z",
    primary: "M18 12H6V30H18V12ZM24 36H0V6H24V36Z",
  },
  v: { primary: "M33.2 6.8 42 28.3 50.8 6.8" },
  e: {
    shadow: "M84 24V30H66V24H84Z",
    primary: "M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z",
  },
  r: {
    shadow: "M108 36H96V18H108V36Z",
    primary: "M108 12H96V36H90V6H108V12ZM114 24H108V12H114V24Z",
  },
  c: {
    shadow: "M144 30H126V18H144V30Z",
    primary: "M144 12H126V30H144V36H120V6H144V12Z",
  },
  d: {
    shadow: "M198 30H186V18H198V30Z",
    primary: "M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z",
  },
}

const svgGlyphs = [
  glyphPaths.o,
  glyphPaths.v,
  glyphPaths.e,
  glyphPaths.r,
  glyphPaths.c,
  {
    shadow: "M168 30H156V18H168V30Z",
    primary: "M168 12H156V30H168V12ZM174 36H150V6H174V36Z",
  },
  glyphPaths.d,
  {
    shadow: "M234 24V30H216V24H234Z",
    primary: "M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z",
  },
]

function svgPath(pathData, fill, extra = "") {
  return `<path d="${pathData}" fill="${fill}"${extra}/>`
}

function svgStroke(pathData, stroke) {
  return `<path d="${pathData}" stroke="${stroke}" stroke-width="6" stroke-linejoin="miter" stroke-linecap="butt"/>`
}

function wordmarkSvg(styleName, width = styleName.toLowerCase().includes("dark") ? 641 : 640, height = 115) {
  const style = styles[styleName]
  const body = svgGlyphs
    .map((glyph, index) => {
      const fill = index < 4 ? style.primary : style.final
      const shadow = style.simple || !glyph.shadow ? "" : svgPath(glyph.shadow, style.shadow)
      const primary = index === 1 ? svgStroke(glyph.primary, fill) : svgPath(glyph.primary, fill)
      return `${shadow}${primary}`
    })
    .join("")
  return `<svg width="${width}" height="${height}" viewBox="0 0 234 42" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>\n`
}

function markSvg(styleName) {
  const style = styles[styleName]
  return `<svg width="240" height="300" viewBox="0 0 240 300" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M180 240H60V120H180V240Z" fill="${style.shadow}"/>
<path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="${style.final}"/>
</svg>\n`
}

function squareMarkSvg(styleName) {
  const style = styles[styleName]
  return `<svg width="300" height="300" viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg">
<g transform="translate(30 0)">
<path d="M180 240H60V120H180V240Z" fill="${style.shadow}"/>
<path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="${style.final}"/>
</g>
</svg>\n`
}

function writeText(file, value) {
  fs.writeFileSync(file, value, "utf8")
}

function writeCanonicalSvgs() {
  const variants = [
    ["light", "overcode-wordmark-light.svg"],
    ["dark", "overcode-wordmark-dark.svg"],
    ["simpleLight", "overcode-wordmark-simple-light.svg"],
    ["simpleDark", "overcode-wordmark-simple-dark.svg"],
  ]
  for (const [style, name] of variants) writeText(path.join(brandDir, name), wordmarkSvg(style))
  for (const [style, name] of [
    ["light", "overcode-logo-light"],
    ["dark", "overcode-logo-dark"],
  ]) {
    writeText(path.join(brandDir, `${name}.svg`), markSvg(style))
    writeText(path.join(brandDir, `${name}-square.svg`), squareMarkSvg(style))
  }
  for (const [style, name] of [
    ["light", "overcode-wordmark-light"],
    ["dark", "overcode-wordmark-dark"],
  ]) {
    writeText(path.join(landerDir, `${name}.svg`), wordmarkSvg(style, 234, 42))
    writeText(path.join(landerDir, `${name.replace("wordmark", "logo")}.svg`), markSvg(style))
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "latin1")
  const body = Buffer.concat([typeBuffer, data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, checksum])
}

function encodePng(image) {
  const rowSize = image.width * 4
  const raw = Buffer.alloc(image.height * (rowSize + 1))
  for (let y = 0; y < image.height; y++) {
    const row = y * (rowSize + 1)
    raw[row] = 0
    Buffer.from(image.data.buffer, image.data.byteOffset + y * rowSize, rowSize).copy(raw, row + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = 6
  const text = Buffer.from("Software\0Overcode deterministic asset generator", "latin1")
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("tEXt", text),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function decodePng(file) {
  const bytes = fs.readFileSync(file)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error(`Not a PNG: ${file}`)
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  let transparency = null
  const idat = []
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString("latin1", offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === "PLTE") palette = data
    else if (type === "tRNS") transparency = data
    else if (type === "IDAT") idat.push(data)
  }
  if (interlace !== 0 || (bitDepth !== 8 && colorType !== 3) || ![1, 2, 4, 8].includes(bitDepth)) {
    throw new Error(`Unsupported PNG format: ${file}`)
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}: ${file}`)
  const bytesPerPixel = Math.max(1, Math.ceil((bitDepth * channels) / 8))
  const stride = Math.ceil((width * bitDepth * channels) / 8)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const data = new Uint8Array(width * height * 4)
  let sourceOffset = 0
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[sourceOffset++]
    const current = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const value = raw[sourceOffset++]
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0
      const above = previous[x] ?? 0
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0
      current[x] =
        (value +
          (filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : filter === 4
                  ? paeth(left, above, upperLeft)
                  : 0)) &
        255
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels
      const target = (y * width + x) * 4
      if (colorType === 6) data.set(current.subarray(source, source + 4), target)
      else if (colorType === 2) {
        data[target] = current[source]
        data[target + 1] = current[source + 1]
        data[target + 2] = current[source + 2]
        data[target + 3] = 255
      } else if (colorType === 3) {
        const packed = current[Math.floor((x * bitDepth) / 8)]
        const shift = 8 - bitDepth - ((x * bitDepth) % 8)
        const paletteIndex = (packed >> shift) & ((1 << bitDepth) - 1)
        if (!palette) throw new Error(`Missing PNG palette: ${file}`)
        data[target] = palette[paletteIndex * 3]
        data[target + 1] = palette[paletteIndex * 3 + 1]
        data[target + 2] = palette[paletteIndex * 3 + 2]
        data[target + 3] = transparency?.[paletteIndex] ?? 255
      } else if (colorType === 4) {
        data[target] = current[source]
        data[target + 1] = current[source]
        data[target + 2] = current[source]
        data[target + 3] = current[source + 1]
      } else {
        data[target] = current[source]
        data[target + 1] = current[source]
        data[target + 2] = current[source]
        data[target + 3] = 255
      }
    }
    previous = current
  }
  return { width, height, data }
}

function color(value) {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
    255,
  ]
}

function setPixel(image, x, y, value) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  image.data.set(value, (y * image.width + x) * 4)
}

function fillRect(image, x, y, width, height, value) {
  const left = Math.max(0, Math.floor(x))
  const top = Math.max(0, Math.floor(y))
  const right = Math.min(image.width, Math.ceil(x + width))
  const bottom = Math.min(image.height, Math.ceil(y + height))
  for (let row = top; row < bottom; row++) {
    for (let column = left; column < right; column++) {
      setPixel(image, column, row, typeof value === "function" ? value(column, row) : value)
    }
  }
}

function clearRect(image, x, y, width, height, fill) {
  fillRect(image, x, y, width, height, fill ?? [0, 0, 0, 0])
}

function strokeSegment(image, x1, y1, x2, y2, width, value) {
  const radius = width / 2
  const minX = Math.floor(Math.min(x1, x2) - radius)
  const maxX = Math.ceil(Math.max(x1, x2) + radius)
  const minY = Math.floor(Math.min(y1, y2) - radius)
  const maxY = Math.ceil(Math.max(y1, y2) + radius)
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - x1
      const py = y + 0.5 - y1
      const projection = lengthSquared === 0 ? 0 : (px * dx + py * dy) / lengthSquared
      if (projection < 0 || projection > 1) continue
      const distanceX = px - dx * projection
      const distanceY = py - dy * projection
      if (distanceX * distanceX + distanceY * distanceY <= radius * radius) setPixel(image, x, y, value)
    }
  }
}

function fillPolygon(image, points, value) {
  const minX = Math.floor(Math.min(...points.map((point) => point.x)))
  const maxX = Math.ceil(Math.max(...points.map((point) => point.x)))
  const minY = Math.floor(Math.min(...points.map((point) => point.y)))
  const maxY = Math.ceil(Math.max(...points.map((point) => point.y)))
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let positive = false
      let negative = false
      for (let index = 0; index < points.length; index++) {
        const current = points[index]
        const next = points[(index + 1) % points.length]
        const cross = (next.x - current.x) * (py - current.y) - (next.y - current.y) * (px - current.x)
        positive ||= cross > 0
        negative ||= cross < 0
      }
      if (!(positive && negative)) setPixel(image, x, y, value)
    }
  }
}

function strokeJoin(image, previous, current, next, width, value) {
  const radius = width / 2
  const firstLength = Math.hypot(current.x - previous.x, current.y - previous.y)
  const secondLength = Math.hypot(next.x - current.x, next.y - current.y)
  if (!firstLength || !secondLength) return
  const first = { x: (current.x - previous.x) / firstLength, y: (current.y - previous.y) / firstLength }
  const second = { x: (next.x - current.x) / secondLength, y: (next.y - current.y) / secondLength }
  const turn = first.x * second.y - first.y * second.x
  if (Math.abs(turn) < 0.0001) return
  const firstNormal = { x: -first.y, y: first.x }
  const secondNormal = { x: -second.y, y: second.x }
  const side = turn > 0 ? -1 : 1
  const firstOuter = { x: current.x + firstNormal.x * radius * side, y: current.y + firstNormal.y * radius * side }
  const secondOuter = { x: current.x + secondNormal.x * radius * side, y: current.y + secondNormal.y * radius * side }
  const denominator = first.x * second.y - first.y * second.x
  const offsetX = secondOuter.x - firstOuter.x
  const offsetY = secondOuter.y - firstOuter.y
  const distance = (offsetX * second.y - offsetY * second.x) / denominator
  const miter = { x: firstOuter.x + first.x * distance, y: firstOuter.y + first.y * distance }
  if (Math.hypot(miter.x - current.x, miter.y - current.y) > radius * 4) {
    fillPolygon(image, [firstOuter, secondOuter, current], value)
    return
  }
  fillPolygon(image, [firstOuter, miter, secondOuter], value)
}

function strokePolyline(image, points, width, value) {
  for (let index = 0; index < points.length - 1; index++) {
    strokeSegment(image, points[index].x, points[index].y, points[index + 1].x, points[index + 1].y, width, value)
  }
  for (let index = 1; index < points.length - 1; index++) {
    strokeJoin(image, points[index - 1], points[index], points[index + 1], width, value)
  }
}

function drawReplacement(image, box, styleName, background) {
  const style = styles[styleName]
  const { x, y, sx, sy } = box
  const clear = background ?? [0, 0, 0, 0]
  clearRect(image, x + 28 * sx, y, 28 * sx, 42 * sy, clear)
  clearRect(image, x + 88 * sx, y, 28 * sx, 42 * sy, clear)
  const primary = color(style.primary)
  const shadow = color(style.shadow)
  strokePolyline(
    image,
    [
      { x: x + 33.2 * sx, y: y + 6.8 * sy },
      { x: x + 42 * sx, y: y + 28.3 * sy },
      { x: x + 50.8 * sx, y: y + 6.8 * sy },
    ],
    6 * Math.min(sx, sy),
    primary,
  )
  if (!style.simple) fillRect(image, x + 96 * sx, y + 18 * sy, 12 * sx, 18 * sy, shadow)
  fillRect(image, x + 90 * sx, y + 6 * sy, 6 * sx, 30 * sy, primary)
  fillRect(image, x + 96 * sx, y + 6 * sy, 12 * sx, 6 * sy, primary)
  fillRect(image, x + 108 * sx, y + 12 * sy, 6 * sx, 12 * sy, primary)
}

function alphaBounds(image) {
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function brandBounds(image, styleName) {
  const style = styles[styleName]
  const colors = [style.primary, style.shadow, style.final].map((value) => color(value).slice(0, 3).join(","))
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4
      if (colors.includes(`${image.data[offset]},${image.data[offset + 1]},${image.data[offset + 2]}`)) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function checkerboardAt(image, bounds) {
  const size = Math.max(1, Math.round(image.width / 60))
  const sampleStep = Math.max(1, Math.floor(Math.min(image.width, image.height) / 300))
  const colors = new Map()
  for (let y = 0; y < image.height; y += sampleStep) {
    for (let x = 0; x < image.width; x += sampleStep) {
      if (bounds && x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height)
        continue
      const offset = (y * image.width + x) * 4
      if (image.data[offset + 3] < 250) continue
      const key = `${image.data[offset]},${image.data[offset + 1]},${image.data[offset + 2]}`
      colors.set(key, (colors.get(key) ?? 0) + 1)
    }
  }
  const background = [...colors.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([value]) => value.split(",").map(Number).concat(255))
  const first = background[0] ?? [255, 255, 255, 255]
  const second = background[1] ?? first
  return (x, y) => ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 0 ? first : second)
}

function replacePng(source, target, styleName, placement = "full", background) {
  const image = decodePng(source)
  let box
  if (placement === "alpha") {
    const bounds = alphaBounds(image)
    const visibleBounds =
      bounds && bounds.width <= image.width * 0.9 && bounds.height <= image.height * 0.9
        ? bounds
        : brandBounds(image, styleName)
    if (!visibleBounds) throw new Error(`Could not locate wordmark: ${source}`)
    box = { x: visibleBounds.x, y: visibleBounds.y, sx: visibleBounds.width / 234, sy: visibleBounds.height / 42 }
    background ??=
      bounds && bounds.width <= image.width * 0.9 && bounds.height <= image.height * 0.9
        ? undefined
        : checkerboardAt(image, visibleBounds)
  } else {
    box = { x: 0, y: 0, sx: image.width / 234, sy: image.height / 42 }
  }
  drawReplacement(image, box, styleName, background)
  fs.writeFileSync(target, encodePng(image))
}

function copy(source, target) {
  fs.copyFileSync(source, target)
}

function writeZip(target, names) {
  const local = []
  const central = []
  let offset = 0

  for (const name of names) {
    const nameBuffer = Buffer.from(name, "utf8")
    const data = fs.readFileSync(path.join(brandDir, name))
    const checksum = crc32(data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBuffer.length, 26)
    local.push(localHeader, nameBuffer, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuffer.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, nameBuffer)

    offset += localHeader.length + nameBuffer.length + data.length
  }

  const centralDirectory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  fs.writeFileSync(target, Buffer.concat([...local, centralDirectory, end]))
}

function writeBrandArchives() {
  const names = fs
    .readdirSync(brandDir)
    .filter((name) => /^(?:overcode-|preview-overcode-).+\.(?:png|svg)$/.test(name))
    .sort()
  const archive = path.join(brandDir, "overcode-brand-assets.zip")
  writeZip(archive, names)
  copy(archive, path.join(publicBrandDir, "overcode-brand-assets.zip"))
  copy(archive, path.join(brandDir, "opencode-brand-assets.zip"))
  copy(archive, path.join(publicBrandDir, "opencode-brand-assets.zip"))
}

function copyLegacyBrandAssets() {
  for (const name of fs.readdirSync(brandDir)) {
    if (!/^(?:overcode-|preview-overcode-).+\.(?:png|svg)$/.test(name)) continue
    const legacyName = name.startsWith("preview-overcode-")
      ? name.replace("preview-overcode-", "preview-opencode-")
      : name.replace("overcode-", "opencode-")
    copy(path.join(brandDir, name), path.join(brandDir, legacyName))
  }
}

function validateLanderAssets() {
  for (const name of ["overcode-min.mp4", "overcode-comparison-min.mp4"]) {
    if (!fs.existsSync(path.join(landerDir, name))) throw new Error(`Missing required lander asset: ${name}`)
  }
}

function createImage(width, height, value) {
  const data = new Uint8Array(width * height * 4)
  for (let offset = 0; offset < data.length; offset += 4) data.set(value, offset)
  return { width, height, data }
}

function blendPixel(image, x, y, value) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height || value[3] === 0) return
  const offset = (y * image.width + x) * 4
  if (value[3] === 255) {
    image.data.set(value, offset)
    return
  }
  const sourceAlpha = value[3] / 255
  const targetAlpha = image.data[offset + 3] / 255
  const alpha = sourceAlpha + targetAlpha * (1 - sourceAlpha)
  for (let channel = 0; channel < 3; channel++) {
    image.data[offset + channel] = Math.round(
      (value[channel] * sourceAlpha + image.data[offset + channel] * targetAlpha * (1 - sourceAlpha)) / alpha,
    )
  }
  image.data[offset + 3] = Math.round(alpha * 255)
}

function drawScaled(image, source, x, y, width, height) {
  for (let targetY = 0; targetY < height; targetY++) {
    const sourceY = Math.min(source.height - 1, Math.floor((targetY * source.height) / height))
    for (let targetX = 0; targetX < width; targetX++) {
      const sourceX = Math.min(source.width - 1, Math.floor((targetX * source.width) / width))
      const offset = (sourceY * source.width + sourceX) * 4
      blendPixel(image, x + targetX, y + targetY, source.data.subarray(offset, offset + 4))
    }
  }
}

function desktopIconPng(width, height, source) {
  const image = createImage(width, height, [23, 21, 21, 255])
  drawScaled(image, source, 0, 0, width, height)
  return encodePng(image)
}

function desktopForegroundPng(width, height, source) {
  const image = createImage(width, height, [0, 0, 0, 0])
  const padding = Math.round(Math.min(width, height) * 0.08)
  drawScaled(image, source, padding, padding, width - padding * 2, height - padding * 2)
  return encodePng(image)
}

function writeIco(target, source) {
  const sizes = [16, 32, 48, 256]
  const images = sizes.map((size) => desktopIconPng(size, size, source))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  const entries = []
  let offset = header.length + sizes.length * 16
  for (let index = 0; index < sizes.length; index++) {
    const size = sizes[index]
    const entry = Buffer.alloc(16)
    entry[0] = size === 256 ? 0 : size
    entry[1] = size === 256 ? 0 : size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(images[index].length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += images[index].length
  }
  fs.writeFileSync(target, Buffer.concat([header, ...entries, ...images]))
}

function writeIcns(target, source) {
  const sizes = [
    ["ic11", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ]
  const entries = sizes.map(([type, size]) => {
    const data = desktopIconPng(size, size, source)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, "ascii")
    header.writeUInt32BE(data.length + header.length, 4)
    return Buffer.concat([header, data])
  })
  const body = Buffer.concat(entries)
  const header = Buffer.alloc(8)
  header.write("icns", 0, 4, "ascii")
  header.writeUInt32BE(body.length + header.length, 4)
  fs.writeFileSync(target, Buffer.concat([header, body]))
}

function walkPngFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkPngFiles(file))
    else if (entry.isFile() && entry.name.endsWith(".png")) files.push(file)
  }
  return files
}

function writeDesktopIconAssets() {
  const source = decodePng(path.join(brandDir, "overcode-logo-dark-square.png"))
  for (const channel of ["dev", "beta", "prod"]) {
    const channelDir = path.join(root, "packages/desktop/icons", channel)
    for (const file of [
      ...fs
        .readdirSync(channelDir)
        .filter((name) => name.endsWith(".png"))
        .map((name) => path.join(channelDir, name)),
      ...walkPngFiles(path.join(channelDir, "ios")),
    ]) {
      const current = decodePng(file)
      fs.writeFileSync(file, desktopIconPng(current.width, current.height, source))
    }
    for (const file of walkPngFiles(path.join(channelDir, "android"))) {
      const current = decodePng(file)
      fs.writeFileSync(
        file,
        file.endsWith("_foreground.png")
          ? desktopForegroundPng(current.width, current.height, source)
          : desktopIconPng(current.width, current.height, source),
      )
    }
    writeIco(path.join(channelDir, "icon.ico"), source)
    writeIcns(path.join(channelDir, "icon.icns"), source)
  }
  const resourcesDir = path.join(root, "packages/desktop/resources/icons")
  for (const name of ["icon.png", "icon.ico", "icon.icns"]) {
    if (fs.existsSync(path.join(resourcesDir, name)))
      copy(path.join(root, "packages/desktop/icons/prod", name), path.join(resourcesDir, name))
  }
}

function run() {
  writeCanonicalSvgs()
  for (const [source, target, style] of [
    ["opencode-wordmark-light.png", "overcode-wordmark-light.png", "light"],
    ["opencode-wordmark-dark.png", "overcode-wordmark-dark.png", "dark"],
    ["opencode-wordmark-simple-light.png", "overcode-wordmark-simple-light.png", "simpleLight"],
    ["opencode-wordmark-simple-dark.png", "overcode-wordmark-simple-dark.png", "simpleDark"],
  ])
    replacePng(path.join(brandDir, source), path.join(brandDir, target), style)
  for (const [source, target, style] of [
    ["preview-opencode-wordmark-light.png", "preview-overcode-wordmark-light.png", "light"],
    ["preview-opencode-wordmark-dark.png", "preview-overcode-wordmark-dark.png", "dark"],
    ["preview-opencode-wordmark-simple-light.png", "preview-overcode-wordmark-simple-light.png", "simpleLight"],
    ["preview-opencode-wordmark-simple-dark.png", "preview-overcode-wordmark-simple-dark.png", "simpleDark"],
  ])
    replacePng(path.join(brandDir, source), path.join(brandDir, target), style, "alpha")
  for (const [source, target] of [
    ["opencode-logo-light.png", "overcode-logo-light.png"],
    ["opencode-logo-dark.png", "overcode-logo-dark.png"],
    ["opencode-logo-light-square.png", "overcode-logo-light-square.png"],
    ["opencode-logo-dark-square.png", "overcode-logo-dark-square.png"],
    ["preview-opencode-logo-light.png", "preview-overcode-logo-light.png"],
    ["preview-opencode-logo-dark.png", "preview-overcode-logo-dark.png"],
    ["preview-opencode-logo-light-square.png", "preview-overcode-logo-light-square.png"],
    ["preview-opencode-logo-dark-square.png", "preview-overcode-logo-dark-square.png"],
    ["preview-opencode-dark.png", "preview-overcode-dark.png"],
  ])
    copy(path.join(brandDir, source), path.join(brandDir, target))
  const mailLogo = path.join(root, "packages/console/mail/emails/templates/static/logo.png")
  const mailLogoSource = path.join(root, "packages/console/mail/emails/templates/static/logo-source.png")
  if (!fs.existsSync(mailLogoSource)) copy(mailLogo, mailLogoSource)
  replacePng(mailLogoSource, mailLogo, "light")
  for (const [source, target] of [
    ["opencode-poster.png", "overcode-poster.png"],
    ["opencode-comparison-poster.png", "overcode-comparison-poster.png"],
  ]) {
    const sourcePath = path.join(landerDir, source)
    const image = decodePng(sourcePath)
    const logoWidth = image.width * 0.24
    const logoHeight = (logoWidth * 42) / 234
    drawReplacement(
      image,
      {
        x: (image.width - logoWidth) / 2,
        y: (image.height - logoHeight) / 2,
        sx: logoWidth / 234,
        sy: logoHeight / 42,
      },
      "poster",
      [0, 0, 0, 255],
    )
    fs.writeFileSync(path.join(landerDir, target), encodePng(image))
  }
  copy(path.join(landerDir, "opencode-desktop-icon.png"), path.join(landerDir, "overcode-desktop-icon.png"))
  copyLegacyBrandAssets()
  writeBrandArchives()
  validateLanderAssets()
  writeDesktopIconAssets()
  console.log("Generated canonical Overcode SVG and PNG brand assets")
}

run()
