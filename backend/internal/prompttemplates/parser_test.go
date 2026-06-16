package prompttemplates

import "testing"

func TestParseReadmeExtractsPromptAndImages(t *testing.T) {
	markdown := `## 🔥 精选提示词

### No. 1: VR 头显爆炸视图海报

#### 🖼️ 生成图片

<img src="https://cms-assets.youmind.com/image-1.png" width="512" />
![Image 2](https://cms-assets.youmind.com/image-2.png)

#### 📖 描述

展示一个 VR 头显的爆炸视图。

#### 📝 提示词

` + "```" + `
Create a clean exploded-view poster.
` + "```" + `

- **作者:** [Demo](https://example.com/demo)
- **来源:** [YouMind](https://example.com/source)
**[👉 立即尝试 →](https://example.com/try)**
`

	templates := ParseReadme(markdown)
	if len(templates) != 1 {
		t.Fatalf("expected 1 template, got %d", len(templates))
	}
	template := templates[0]
	if template.Title != "VR 头显爆炸视图海报" {
		t.Fatalf("unexpected title: %s", template.Title)
	}
	if template.Category != "精选" {
		t.Fatalf("unexpected category: %s", template.Category)
	}
	if template.Prompt != "Create a clean exploded-view poster." {
		t.Fatalf("unexpected prompt: %s", template.Prompt)
	}
	if len(template.ImageURLs) != 2 {
		t.Fatalf("expected 2 image URLs, got %d", len(template.ImageURLs))
	}
	if template.ImageURLs[0] != "https://cms-assets.youmind.com/image-1.png" {
		t.Fatalf("unexpected first image URL: %s", template.ImageURLs[0])
	}
}

func TestParseReadmeIgnoresImagesOutsideGeneratedImageSection(t *testing.T) {
	markdown := `### No. 1: 测试模板

![Language-EN](https://img.shields.io/badge/Language-EN-blue)

#### 📖 描述

测试描述。

#### 📝 提示词

` + "```" + `
Prompt.
` + "```" + `

#### 🖼️ 生成图片

<img src="https://cms-assets.youmind.com/media/result.jpg" width="600" alt="result">

#### 贡献者

<img src="https://example.com/avatar.jpg" width="32" alt="avatar">
`

	templates := ParseReadme(markdown)
	if len(templates) != 1 {
		t.Fatalf("expected 1 template, got %d", len(templates))
	}
	if len(templates[0].ImageURLs) != 1 {
		t.Fatalf("expected exactly one generated image, got %d: %#v", len(templates[0].ImageURLs), templates[0].ImageURLs)
	}
	if templates[0].ImageURLs[0] != "https://cms-assets.youmind.com/media/result.jpg" {
		t.Fatalf("unexpected image URL: %s", templates[0].ImageURLs[0])
	}
}

func TestParseReadmeKeepsRepeatedNumbersDistinct(t *testing.T) {
	markdown := `## 🔥 精选提示词

### No. 1: 精选模板

#### 📖 描述

精选描述。

#### 📝 提示词

` + "```" + `
Featured prompt.
` + "```" + `

## 📋 所有提示词

### No. 1: 普通模板

#### 📖 描述

普通描述。

#### 📝 提示词

` + "```" + `
Regular prompt.
` + "```" + `
`

	templates := ParseReadme(markdown)
	if len(templates) != 2 {
		t.Fatalf("expected 2 templates, got %d", len(templates))
	}
	if templates[0].SourceExternalID == templates[1].SourceExternalID {
		t.Fatalf("expected distinct source external ids, got %s", templates[0].SourceExternalID)
	}
	if templates[0].ID == templates[1].ID {
		t.Fatalf("expected distinct ids, got %s", templates[0].ID)
	}
}
