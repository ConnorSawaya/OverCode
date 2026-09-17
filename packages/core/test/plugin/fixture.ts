import { AgentV2 } from "@overcode-ai/core/agent"
import { AISDK } from "@overcode-ai/core/aisdk"
import { Catalog } from "@overcode-ai/core/catalog"
import { CommandV2 } from "@overcode-ai/core/command"
import { Credential } from "@overcode-ai/core/credential"
import { AppNodeBuilder } from "@overcode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@overcode-ai/core/effect/app-node-platform"
import { LayerNode } from "@overcode-ai/core/effect/layer-node"
import { EventV2 } from "@overcode-ai/core/event"
import { FileSystem } from "@overcode-ai/core/filesystem"
import { FSUtil } from "@overcode-ai/core/fs-util"
import { Integration } from "@overcode-ai/core/integration"
import { Location } from "@overcode-ai/core/location"
import { Npm } from "@overcode-ai/core/npm"
import { PluginV2 } from "@overcode-ai/core/plugin"
import { Reference } from "@overcode-ai/core/reference"
import { SkillV2 } from "@overcode-ai/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
