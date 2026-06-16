import { describe, expect, it } from 'vitest'
import { fetchPromptTemplates, formatTemplatePrompt } from './promptTemplates'

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

  it('loads the public awesome-gpt-image-2 README templates with formatted prompts', async () => {
    const templates = await fetchPromptTemplates()

    expect(templates.length).toBeGreaterThanOrEqual(120)
    expect(templates.some((template) => template.title === 'VR 头显爆炸视图海报')).toBe(true)
    expect(templates.some((template) => template.category === '精选')).toBe(true)
    expect(templates.every((template) => !template.prompt.includes('{argument'))).toBe(true)
  })
})
