#!/usr/bin/env bun
/**
 * Claude Code Lark/Feishu Channel Plugin
 *
 * An MCP server that bridges Lark/Feishu messaging with Claude Code.
 * Uses Lark SDK WebSocket for real-time message reception and
 * exposes reply/react tools for Claude to respond.
 *
 * Environment variables:
 *   LARK_APP_ID       - Feishu app ID
 *   LARK_APP_SECRET   - Feishu app secret
 *   LARK_BRAND        - "feishu" (default) or "lark"
 *   LARK_ALLOW_FROM   - Comma-separated open_id allowlist (empty = allow all)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import * as Lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync, createReadStream } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))

const APP_ID = process.env.LARK_APP_ID ?? ''
const APP_SECRET = process.env.LARK_APP_SECRET ?? ''
const BRAND = (process.env.LARK_BRAND ?? 'feishu') as 'feishu' | 'lark'

const DOMAIN = BRAND === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu

// Sender allowlist — empty means allow all
const allowFromEnv = process.env.LARK_ALLOW_FROM ?? ''
const allowed = new Set(
  allowFromEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

// Access config file for persistent allowlist
const ACCESS_PATH = join(__dirname, 'access.json')

interface AccessConfig {
  allowFrom: string[]
  dmPolicy: 'allowlist' | 'open'
}

function loadAccess(): AccessConfig {
  if (existsSync(ACCESS_PATH)) {
    try {
      return JSON.parse(readFileSync(ACCESS_PATH, 'utf-8'))
    } catch {
      // fall through
    }
  }
  return { allowFrom: [], dmPolicy: 'open' }
}

function saveAccess(config: AccessConfig): void {
  writeFileSync(ACCESS_PATH, JSON.stringify(config, null, 2))
}

const accessConfig = loadAccess()
for (const id of accessConfig.allowFrom) {
  allowed.add(id)
}

// ---------------------------------------------------------------------------
// Lark SDK client
// ---------------------------------------------------------------------------

if (!APP_ID || !APP_SECRET) {
  console.error(
    'LARK_APP_ID and LARK_APP_SECRET are required. Set them as environment variables.',
  )
  process.exit(1)
}

const larkClient = new Lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  appType: Lark.AppType.SelfBuild,
  domain: DOMAIN,
})

// ---------------------------------------------------------------------------
// Message dedup
// ---------------------------------------------------------------------------

const seenMessages = new Map<string, number>()
const DEDUP_TTL_MS = 5 * 60 * 1000 // 5 minutes
const DEDUP_MAX = 1000

function isDuplicate(messageId: string): boolean {
  const now = Date.now()
  // Cleanup old entries
  if (seenMessages.size > DEDUP_MAX) {
    for (const [id, ts] of seenMessages) {
      if (now - ts > DEDUP_TTL_MS) seenMessages.delete(id)
    }
  }
  if (seenMessages.has(messageId)) return true
  seenMessages.set(messageId, now)
  return false
}

// Message expiry — discard messages older than 2 minutes
function isExpired(createTime?: string): boolean {
  if (!createTime) return false
  const ts = parseInt(createTime, 10)
  if (isNaN(ts)) return false
  // createTime is in milliseconds
  return Date.now() - ts > 2 * 60 * 1000
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'lark-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      'Messages from Lark/Feishu arrive as <channel source="plugin:lark-channel:lark-channel" chat_id="..." message_id="..." user="..." user_id="..." ts="...">.',
      'Reply with the lark_reply tool, passing chat_id from the tag.',
      'React with the lark_react tool, passing message_id and an UPPERCASE emoji type (e.g. THUMBSUP, OK, SMILE, HEART).',
      'Send a new message with lark_send tool to any chat_id or user open_id.',
      'Feishu reactions use UPPERCASE emoji type names, not Unicode emoji characters.',
      'Attachment files can be sent via lark_reply with file_key parameter (upload first via Feishu API).',
    ].join('\n'),
  },
)

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'lark_reply',
      description:
        'Reply to a Lark/Feishu conversation. Pass chat_id from the inbound <channel> tag.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description: 'The chat ID to reply in (from the channel tag)',
          },
          text: {
            type: 'string',
            description: 'The message text to send',
          },
          reply_to: {
            type: 'string',
            description:
              'Optional message_id to reply to in thread',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'lark_react',
      description:
        'Add an emoji reaction to a Lark/Feishu message. Uses UPPERCASE emoji type names (e.g. THUMBSUP, OK, SMILE, HEART, MUSCLE, FIRE, EYES, CLAP, JOYFUL, FROWN, PARTY, BLUSH, THINKING, DONE, THANKS, FINGERHEART, APPLAUSE, FISTBUMP, JIAYI).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: {
            type: 'string',
            description: 'The message_id to react to',
          },
          emoji: {
            type: 'string',
            description:
              'UPPERCASE emoji type name (e.g. THUMBSUP, OK, SMILE, HEART)',
          },
        },
        required: ['message_id', 'emoji'],
      },
    },
    {
      name: 'lark_send',
      description:
        'Send a new message to a Lark/Feishu chat or user. Use chat_id for group chats or open_id for DMs.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          receive_id: {
            type: 'string',
            description: 'Target chat_id or user open_id',
          },
          receive_id_type: {
            type: 'string',
            enum: ['chat_id', 'open_id'],
            description: 'Type of the receive_id (default: chat_id)',
          },
          text: {
            type: 'string',
            description: 'The message text to send',
          },
        },
        required: ['receive_id', 'text'],
      },
    },
    {
      name: 'lark_fetch_messages',
      description:
        'Fetch recent messages from a Lark/Feishu chat.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description: 'The chat ID to fetch messages from',
          },
          page_size: {
            type: 'number',
            description: 'Number of messages to fetch (default: 20, max: 50)',
          },
        },
        required: ['chat_id'],
      },
    },
    {
      name: 'lark_send_image',
      description:
        'Send a local image file to a Lark/Feishu conversation. Uploads the image first, then sends it. Supports JPEG, PNG, GIF, BMP, WEBP.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description: 'The chat ID to send the image to',
          },
          file_path: {
            type: 'string',
            description: 'Absolute path to the local image file',
          },
          receive_id_type: {
            type: 'string',
            enum: ['chat_id', 'open_id'],
            description: 'Type of the chat_id (default: chat_id)',
          },
        },
        required: ['chat_id', 'file_path'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  const params = args as Record<string, unknown>

  try {
    switch (name) {
      case 'lark_reply': {
        const chatId = params.chat_id as string
        const text = params.text as string
        const replyTo = params.reply_to as string | undefined

        // Use post format with md tag for markdown rendering
        const content = JSON.stringify({
          zh_cn: {
            content: [[{ tag: 'md', text }]],
          },
        })

        if (replyTo) {
          // Reply in thread
          await larkClient.im.message.reply({
            path: { message_id: replyTo },
            data: { content, msg_type: 'post' },
          })
        } else {
          await larkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'post',
              content,
            } as any,
          })
        }
        return { content: [{ type: 'text', text: 'sent' }] }
      }

      case 'lark_react': {
        const messageId = params.message_id as string
        const emoji = params.emoji as string

        await larkClient.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emoji } },
        })
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'lark_send': {
        const receiveId = params.receive_id as string
        const receiveIdType = (params.receive_id_type as string) || 'chat_id'
        const text = params.text as string

        // Use post format with md tag for markdown rendering
        const sendContent = JSON.stringify({
          zh_cn: {
            content: [[{ tag: 'md', text }]],
          },
        })

        await larkClient.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: receiveId,
            msg_type: 'post',
            content: sendContent,
          } as any,
        })
        return { content: [{ type: 'text', text: 'sent' }] }
      }

      case 'lark_fetch_messages': {
        const chatId = params.chat_id as string
        const pageSize = Math.min((params.page_size as number) || 20, 50)

        const res = await larkClient.im.message.list({
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            page_size: pageSize,
            sort_type: 'ByCreateTimeDesc',
          },
        })

        const items = (res?.items ?? []).map((msg: any) => ({
          message_id: msg.message_id,
          msg_type: msg.msg_type,
          sender_id: msg.sender?.id,
          create_time: msg.create_time,
          body: msg.body?.content,
        }))

        return {
          content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        }
      }

      case 'lark_send_image': {
        const chatId = params.chat_id as string
        const filePath = params.file_path as string
        const receiveIdType = (params.receive_id_type as string) || 'chat_id'

        // Upload image to Feishu
        const imageStream = createReadStream(filePath)
        const uploadRes = await larkClient.im.image.create({
          data: { image_type: 'message', image: imageStream as any },
        })

        const imageKey =
          (uploadRes as any)?.data?.image_key ??
          (uploadRes as any)?.image_key
        if (!imageKey) {
          throw new Error('Image upload failed: no image_key returned')
        }

        // Send image message
        await larkClient.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: chatId,
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
          } as any,
        })
        return { content: [{ type: 'text', text: `sent (image_key: ${imageKey})` }] }
      }

      default:
        throw new Error(`unknown tool: ${name}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `error: ${message}` }], isError: true }
  }
})

// ---------------------------------------------------------------------------
// Permission relay
// ---------------------------------------------------------------------------

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

// Store the last active chat for permission prompts
let lastActiveChatId: string | null = null

// Map permission message_id → request_id for reaction-based approval
const permissionMessages = new Map<string, string>()
const PERMISSION_MSG_TTL_MS = 10 * 60 * 1000 // 10 minutes

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!lastActiveChatId) return
  try {
    const permText = `🔐 Claude wants to run **${params.tool_name}**: ${params.description}\n\nReact **YES** to approve, **NO** to deny`
    const res = await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: lastActiveChatId,
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: { content: [[{ tag: 'md', text: permText }]] },
        }),
      } as any,
    })

    // Store message_id → request_id mapping
    const msgId = (res as any)?.data?.message_id ?? (res as any)?.message_id
    if (msgId) {
      permissionMessages.set(msgId, params.request_id)
      // Auto-cleanup after TTL
      setTimeout(() => permissionMessages.delete(msgId), PERMISSION_MSG_TTL_MS)
    }
  } catch (err) {
    // Permission relay is best-effort
  }
})

// Permission verdict regex
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------------------------------------------------------------------------
// Sender gate
// ---------------------------------------------------------------------------

function isSenderAllowed(openId: string): boolean {
  // If no allowlist configured, allow all (open policy)
  if (allowed.size === 0 && accessConfig.dmPolicy === 'open') return true
  return allowed.has(openId)
}

// ---------------------------------------------------------------------------
// Parse message content
// ---------------------------------------------------------------------------

function extractTextContent(msgType: string, content: string): string {
  try {
    const parsed = JSON.parse(content)
    switch (msgType) {
      case 'text':
        return parsed.text ?? content
      case 'post': {
        // Rich text — extract plain text from all paragraphs
        const lines: string[] = []
        const post = parsed.zh_cn ?? parsed.en_us ?? Object.values(parsed)[0]
        if (post?.content) {
          for (const paragraph of post.content) {
            const parts = (paragraph as any[])
              .map((el: any) => {
                if (el.tag === 'text') return el.text
                if (el.tag === 'a') return el.text ?? el.href
                if (el.tag === 'at') return `@${el.user_name ?? el.user_id}`
                return ''
              })
              .filter(Boolean)
            lines.push(parts.join(''))
          }
        }
        return lines.join('\n') || content
      }
      case 'image':
        return '[image]'
      case 'file':
        return `[file: ${parsed.file_name ?? 'unknown'}]`
      case 'audio':
        return '[audio]'
      case 'sticker':
        return '[sticker]'
      case 'interactive':
        return parsed.header?.title?.content ?? '[interactive card]'
      default:
        return content
    }
  } catch {
    return content
  }
}

// ---------------------------------------------------------------------------
// WebSocket event handling
// ---------------------------------------------------------------------------

async function startLarkWebSocket(): Promise<void> {
  const dispatcher = new Lark.EventDispatcher({})

  // Permission reaction emoji mappings (case-sensitive Feishu emoji types)
  // [赞] THUMBSUP, [OK] OK, [Yes] Yes, [+1] JIAYI, [我看行] LGTM, [勾号] CheckMark
  const APPROVE_EMOJIS = new Set(['THUMBSUP', 'OK', 'Yes', 'JIAYI', 'LGTM', 'CheckMark'])
  // [No] No, [叉号] CrossMark, [踩] ThumbsDown, [-1] MinusOne
  const DENY_EMOJIS = new Set(['No', 'CrossMark', 'ThumbsDown', 'MinusOne'])

  // Register message and reaction handlers
  dispatcher.register({
    // Handle reaction events for permission relay
    'im.message.reaction.created_v1': async (data: any) => {
      try {
        const messageId = data.message_id ?? ''
        const emojiType = data.reaction_type?.emoji_type ?? ''

        // Check if this reaction is on a permission message
        const requestId = permissionMessages.get(messageId)
        if (!requestId) return

        let behavior: 'allow' | 'deny' | null = null
        if (APPROVE_EMOJIS.has(emojiType)) {
          behavior = 'allow'
        } else if (DENY_EMOJIS.has(emojiType)) {
          behavior = 'deny'
        }

        if (behavior) {
          await mcp.notification({
            method: 'notifications/claude/channel/permission' as any,
            params: { request_id: requestId, behavior },
          })
          // Clean up after verdict
          permissionMessages.delete(messageId)
        }
      } catch (err) {
        console.error('Error handling reaction for permission:', err)
      }
    },

    'im.message.receive_v1': async (data: any) => {
      try {
        const event = data
        const message = event.message
        if (!message) return

        const messageId = message.message_id ?? ''
        const chatId = message.chat_id ?? ''
        const chatType = message.chat_type ?? ''
        const msgType = message.message_type ?? 'text'
        const createTime = message.create_time ?? ''
        const senderOpenId = event.sender?.sender_id?.open_id ?? ''
        const senderType = event.sender?.sender_type ?? ''

        // Skip bot's own messages
        if (senderType === 'app') return

        // Dedup
        if (isDuplicate(messageId)) return

        // Expiry
        if (isExpired(createTime)) return

        // Sender gate
        if (!isSenderAllowed(senderOpenId)) return

        // Extract text content
        const content = message.content ?? '{}'
        const textContent = extractTextContent(msgType, content)

        // Track last active chat for permission relay
        lastActiveChatId = chatId

        // Check for permission verdict
        const verdictMatch = PERMISSION_REPLY_RE.exec(textContent)
        if (verdictMatch) {
          await mcp.notification({
            method: 'notifications/claude/channel/permission' as any,
            params: {
              request_id: verdictMatch[2].toLowerCase(),
              behavior: verdictMatch[1].toLowerCase().startsWith('y')
                ? 'allow'
                : 'deny',
            },
          })
          return
        }

        // Build mention info
        const mentions = (message.mentions ?? [])
          .map((m: any) => `@${m.name ?? m.id?.open_id ?? ''}`)
          .filter(Boolean)
        const mentionStr =
          mentions.length > 0 ? ` mentions="${mentions.join(',')}"` : ''

        // Get sender name (best effort)
        let senderName = senderOpenId
        try {
          // Try to get from mentions in event
          if (event.sender?.sender_id?.open_id) {
            senderName = event.sender.sender_id.open_id
          }
        } catch {
          // Use open_id as fallback
        }

        // Build timestamp
        const ts = createTime
          ? new Date(parseInt(createTime, 10)).toISOString()
          : new Date().toISOString()

        // Emit channel notification
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: textContent,
            meta: {
              chat_id: chatId,
              message_id: messageId,
              user: senderName,
              user_id: senderOpenId,
              ts,
              chat_type: chatType,
              msg_type: msgType,
            },
          },
        })
      } catch (err) {
        // Log but don't crash
        console.error('Error handling Lark message:', err)
      }
    },
  } as any)

  // Start WebSocket
  const wsClient = new Lark.WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    domain: DOMAIN,
    loggerLevel: Lark.LoggerLevel.info,
  })

  await wsClient.start({ eventDispatcher: dispatcher })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Connect MCP server to Claude Code via stdio
  await mcp.connect(new StdioServerTransport())

  // Start Lark WebSocket connection
  await startLarkWebSocket()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
