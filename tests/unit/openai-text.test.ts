import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractChatCompletionText,
  extractJsonValue,
  extractResponsesSseText,
  extractResponsesText,
  generateTextViaOpenAICompat,
  generateTextWithFallback,
  resolveChatCompletionsEndpoint,
  resolveResponsesEndpoint,
} from '../../src/lib/openai-text'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI-compatible text helpers', () => {
  it('normalizes chat and responses endpoints', () => {
    expect(resolveChatCompletionsEndpoint('https://example.com')).toBe('https://example.com/v1/chat/completions')
    expect(resolveResponsesEndpoint('https://example.com/v1/')).toBe('https://example.com/v1/responses')
    expect(resolveChatCompletionsEndpoint('https://versioned-provider.example/api/v3/')).toBe(
      'https://versioned-provider.example/api/v3/chat/completions',
    )
    expect(resolveResponsesEndpoint('https://versioned-provider.example/api/v3')).toBe(
      'https://versioned-provider.example/api/v3/responses',
    )
  })

  it('extracts text from chat completions and Responses payloads', () => {
    expect(extractChatCompletionText({ choices: [{ message: { content: '  完成  ' } }] })).toBe('完成')
    expect(extractResponsesText({
      output: [{ content: [{ type: 'output_text', text: '第一段' }, { output_text: '第二段' }] }],
    })).toBe('第一段第二段')
  })

  it('joins Responses API SSE text deltas', () => {
    const stream = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"第一段"}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"第二段"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}',
    ].join('\n\n')
    expect(extractResponsesSseText(stream)).toBe('第一段第二段')
  })

  it('falls back to the completed Responses SSE payload', () => {
    const stream = 'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"完成"}]}]}}'
    expect(extractResponsesSseText(stream)).toBe('完成')
  })

  it('parses fenced or explanatory JSON output', () => {
    expect(extractJsonValue('```json\n{"episodes":[1]}\n```')).toEqual({ episodes: [1] })
    expect(extractJsonValue('结果如下：\n{"assets":[{"name":"苏文菁"}]}\n请确认')).toEqual({
      assets: [{ name: '苏文菁' }],
    })
  })

  it('uses DeepSeek JSON output with thinking disabled for structured work', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"ready":true}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await generateTextViaOpenAICompat({
      baseUrl: 'https://deepseek.example/v1',
      apiKey: 'secret',
      model: 'deepseek-chat',
      mode: 'chat_completions',
      system: 'Return JSON.',
      prompt: 'ready',
      responseFormat: 'json_object',
      disableThinking: true,
      maxAttempts: 1,
    })

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
    })
  })

  it('switches from a moderated primary provider to the fallback provider', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'prompt rejected by content moderation' },
      }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await generateTextWithFallback({
      baseUrl: 'https://ai.cangyuansuanli.cn',
      apiKey: 'primary-secret',
      model: 'gpt-5.5',
      mode: 'chat_completions',
      system: 'system',
      prompt: 'prompt',
      maxAttempts: 1,
    }, {
      baseUrl: 'https://sub.kedaya.xyz',
      apiKey: 'fallback-secret',
      model: 'grok-4.5',
      mode: 'responses',
      system: 'system',
      prompt: 'prompt',
      maxAttempts: 1,
    }, { primary: 'Cangyuan', fallback: 'Kedaya' })

    expect(output).toBe('{"ok":true}')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ai.cangyuansuanli.cn/v1/chat/completions')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://sub.kedaya.xyz/v1/responses')
  })
})
