import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import { tool } from '@langchain/core/tools'
import type { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { McpServerConfig, McpServerStateEntry, McpServerStatus } from './types'

interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

interface TextContent {
  type: 'text'
  text: string
}

interface ServerState {
  config: McpServerConfig
  client: Client
  tools: McpToolDefinition[]
  status: McpServerStatus
  error?: string
}

export class McpManager {
  private servers = new Map<string, ServerState>()
  private langChainTools: StructuredTool[] = []

  async initialize(configs: McpServerConfig[]): Promise<void> {
    const enabled = configs.filter(c => c.enabled)
    for (const config of enabled) {
      await this.connectServer(config)
    }
    this.rebuildTools()
  }

  async reconnect(configs: McpServerConfig[]): Promise<void> {
    const newIds = new Set(configs.filter(c => c.enabled).map(c => c.id))
    const existingIds = new Set(this.servers.keys())

    for (const id of existingIds) {
      if (!newIds.has(id)) {
        await this.disconnectServer(id)
      }
    }

    for (const config of configs) {
      if (!config.enabled) continue
      const existing = this.servers.get(config.id)
      if (!existing) {
        await this.connectServer(config)
      } else if (this.configChanged(existing.config, config)) {
        await this.disconnectServer(config.id)
        await this.connectServer(config)
      }
    }

    this.rebuildTools()
  }

  getTools(): StructuredTool[] {
    return this.langChainTools
  }

  getStatus(): McpServerStateEntry[] {
    const entries: McpServerStateEntry[] = []
    for (const [, state] of this.servers) {
      entries.push({
        configId: state.config.id,
        name: state.config.name,
        status: state.status,
        toolCount: state.tools.length,
        error: state.error
      })
    }
    return entries
  }

  async disconnectAll(): Promise<void> {
    for (const id of this.servers.keys()) {
      await this.disconnectServer(id)
    }
  }

  private async connectServer(config: McpServerConfig): Promise<void> {
    const client = new Client(
      { name: 'langchain-agent-desktop', version: '0.1.0' },
      { capabilities: {} }
    )

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...config.env }
    })

    const state: ServerState = {
      config,
      client,
      tools: [],
      status: 'connecting'
    }

    this.servers.set(config.id, state)

    try {
      await client.connect(transport)
      const result = await client.listTools()
      state.tools = result.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>
      }))
      state.status = 'connected'
    } catch (err) {
      state.status = 'error'
      state.error = err instanceof Error ? err.message : String(err)
      console.error(`[mcp] Failed to connect to "${config.name}":`, state.error)
    }
  }

  private async disconnectServer(id: string): Promise<void> {
    const state = this.servers.get(id)
    if (!state) return
    try {
      await state.client.close()
    } catch {
      // best-effort cleanup
    }
    this.servers.delete(id)
  }

  private configChanged(a: McpServerConfig, b: McpServerConfig): boolean {
    return (
      a.command !== b.command ||
      JSON.stringify(a.args) !== JSON.stringify(b.args) ||
      JSON.stringify(a.env) !== JSON.stringify(b.env)
    )
  }

  private rebuildTools(): void {
    const tools: StructuredTool[] = []
    for (const [, state] of this.servers) {
      if (state.status !== 'connected') continue
      for (const mcpTool of state.tools) {
        tools.push(this.convertTool(mcpTool, state))
      }
    }
    this.langChainTools = tools
  }

  private convertTool(mcpTool: McpToolDefinition, state: ServerState): StructuredTool {
    const serverName = state.config.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
    const fullName = `mcp__${serverName}__${mcpTool.name}`

    return tool(
      async (input: Record<string, unknown>) => {
        if (state.status !== 'connected') {
          return `Error: MCP server "${state.config.name}" is ${state.status}`
        }
        try {
          const result = await state.client.callTool({
            name: mcpTool.name,
            arguments: input
          })
          const content = result.content as TextContent[]
          if (result.isError) {
            const text = content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n')
            return `Error from MCP tool "${mcpTool.name}": ${text || 'unknown error'}`
          }
          return content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `MCP tool "${mcpTool.name}" failed: ${msg}`
        }
      },
      {
        name: fullName,
        description: `[MCP server: ${state.config.name}] ${mcpTool.description ?? `Tool: ${mcpTool.name}`}`,
        schema: convertInputSchemaToZod(mcpTool.inputSchema)
      }
    )
  }
}

let instance: McpManager | null = null

export function getMcpManager(): McpManager {
  if (!instance) {
    instance = new McpManager()
  }
  return instance
}

function convertInputSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const schemaType = schema['type']
  if (
    schemaType === 'object' &&
    typeof schema['properties'] === 'object' &&
    schema['properties'] !== null
  ) {
    const properties = schema['properties'] as Record<string, Record<string, unknown>>
    const required = Array.isArray(schema['required'])
      ? new Set(schema['required'] as string[])
      : new Set<string>()
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [key, propSchema] of Object.entries(properties)) {
      const zodType = convertPropertyToZod(propSchema)
      shape[key] = required.has(key) ? zodType : zodType.optional()
    }
    return z.object(shape)
  }
  return z.record(z.string(), z.any()).describe('Tool input — see description for expected fields')
}

function convertPropertyToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const propType = schema['type']
  const description = typeof schema['description'] === 'string' ? schema['description'] : undefined

  switch (propType) {
    case 'string': {
      const hasEnum =
        Array.isArray(schema['enum']) && schema['enum'].every(e => typeof e === 'string')
      const validValues = hasEnum ? (schema['enum'] as string[]).join(', ') : null
      let s = z.string()
      if (validValues)
        s = s
          .describe(`Valid values: ${validValues}. ${description ?? ''}`)
          .refine(v => (schema['enum'] as string[]).includes(v), {
            message: `Must be one of: ${validValues}`
          })
      else if (description) s = s.describe(description)
      return s
    }
    case 'number':
    case 'integer': {
      let n = z.number()
      if (description) n = n.describe(description)
      return n
    }
    case 'boolean': {
      let b = z.boolean()
      if (description) b = b.describe(description)
      return b
    }
    case 'array': {
      const items = schema['items'] as Record<string, unknown> | undefined
      const elementType = items ? convertPropertyToZod(items) : z.any()
      let a = z.array(elementType)
      if (description) a = a.describe(description)
      return a
    }
    default: {
      let p = z.record(z.string(), z.any())
      if (description) p = p.describe(description)
      return p
    }
  }
}
