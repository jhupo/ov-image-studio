import { describe, expect, it } from 'vitest'
import { formatTemplatePrompt } from './promptTemplates'

describe('formatTemplatePrompt', () => {
  it('keeps JSON prompt structure and replaces argument placeholders with defaults', () => {
    const prompt = formatTemplatePrompt(`{
      "type": "mobile app UI mockup",
      "theme": "light mode, {argument name=\\"primary color\\" default=\\"soft blue\\"} accents",
      "labels": ["{argument name=\\"app name\\" default=\\"FlowBridge\\"}", "Tasks"]
    }`)

    expect(prompt).toContain('type: mobile app UI mockup')
    expect(prompt).toContain('theme: light mode, soft blue accents')
    expect(prompt).toContain('labels: FlowBridge, Tasks')
    expect(prompt).not.toContain('{argument')
    expect(prompt).not.toContain('"type"')
  })

  it('keeps plain text prompts complete while replacing argument placeholders', () => {
    const prompt = formatTemplatePrompt('A portrait in a {argument name="style" default="cinematic film"} style with soft light.')

    expect(prompt).toBe('A portrait in a cinematic film style with soft light.')
  })
})
