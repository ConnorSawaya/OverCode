import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "ai.overcode.desktop" : `ai.overcode.desktop.${channel}`
const productName = channel === "prod" ? "Overcode" : `Overcode ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `Overcode - open source AI coding agent${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="dev.overcode">
    <name>Overcode</name>
  </developer>

  <description>
    <p>
      Overcode is a community fork of the open source overcode agent that helps
      you write and run code with any AI model.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/ConnorSawaya/overcode/issues</url>
  <url type="homepage">https://github.com/ConnorSawaya/overcode</url>
  <url type="vcs-browser">https://github.com/ConnorSawaya/overcode</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
