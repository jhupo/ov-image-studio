package prompttemplates

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"html"
	"regexp"
	"strings"
)

var (
	headingPattern = regexp.MustCompile(`(?m)^### No\.\s*(\d+):\s*(.+)$`)
	promptPattern  = regexp.MustCompile(`(?s)#### 📝 提示词\s*\n\s*` + "```" + `[^\n]*\n(.*?)\n` + "```")
	descPattern    = regexp.MustCompile(`(?s)#### 📖 描述\s*\n\s*(.*?)\n\s*#### 📝 提示词`)
	imgPattern     = regexp.MustCompile(`<img\s+[^>]*src="([^"]+)"[^>]*>`)
	mdImagePattern = regexp.MustCompile(`!\[[^\]]*\]\((https://[^)\s]+)\)`)
	authorPattern  = regexp.MustCompile(`- \*\*作者:\*\* \[([^\]]+)\]\(([^)]+)\)`)
	sourcePattern  = regexp.MustCompile(`- \*\*来源:\*\* \[[^\]]+\]\(([^)]+)\)`)
	detailPattern  = regexp.MustCompile(`\*\*\[👉 立即尝试 →\]\(([^)]+)\)\*\*`)
	langPattern    = regexp.MustCompile(`Language-([A-Z]+)`)
)

func ParseReadme(markdown string) []Template {
	matches := headingPattern.FindAllStringSubmatchIndex(markdown, -1)
	templates := make([]Template, 0, len(matches))
	for index, match := range matches {
		start := match[0]
		end := len(markdown)
		if index+1 < len(matches) {
			end = matches[index+1][0]
		}
		block := markdown[start:end]
		no := markdown[match[2]:match[3]]
		title := strings.TrimSpace(markdown[match[4]:match[5]])
		prompt := firstSubmatch(promptPattern, block)
		if strings.TrimSpace(prompt) == "" {
			continue
		}
		summary := normalizeInline(firstSubmatch(descPattern, block))
		author := firstSubmatch(authorPattern, block)
		if author == "" {
			author = "YouMind OpenLab 社区"
		}
		featured := isFeatured(markdown, start) || strings.Contains(block, "Featured")
		raycast := strings.Contains(block, "Raycast_Friendly")
		language := strings.Join(unique(langPattern.FindAllStringSubmatch(block, -1)), ",")
		category := detectCategory(title, featured)
		imageURLs := imageURLs(block)
		tags := []string{category}
		if featured {
			tags = append(tags, "精选")
		}
		if raycast {
			tags = append(tags, "可变参数")
		}
		if language != "" {
			tags = append(tags, "语言-"+language)
		}
		sourceExternalID := fmt.Sprintf("%04d-no-%s", index+1, no)
		templates = append(templates, Template{
			ID:               stableID(sourceExternalID, title),
			Source:           DefaultSource,
			SourceExternalID: sourceExternalID,
			Title:            title,
			Summary:          summary,
			Prompt:           strings.TrimSpace(prompt),
			Category:         category,
			Tags:             dedupe(tags),
			ImageURLs:        imageURLs,
			Author:           html.UnescapeString(author),
			SourceURL:        firstSubmatch(sourcePattern, block),
			DetailURL:        firstSubmatch(detailPattern, block),
			Featured:         featured,
			Raycast:          raycast,
			Language:         language,
			SortOrder:        index + 1,
		})
	}
	return templates
}

func firstSubmatch(pattern *regexp.Regexp, text string) string {
	match := pattern.FindStringSubmatch(text)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(html.UnescapeString(match[1]))
}

func normalizeInline(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
}

func imageURLs(block string) []string {
	if start := strings.Index(block, "生成图片"); start >= 0 {
		after := block[start+len("生成图片"):]
		block = after
		if beforeNextSection, _, ok := strings.Cut(block, "\n#### "); ok {
			block = beforeNextSection
		}
	}
	urls := make([]string, 0, 4)
	matches := imgPattern.FindAllStringSubmatch(block, -1)
	for _, match := range matches {
		if len(match) > 1 && strings.HasPrefix(match[1], "https://") {
			urls = append(urls, html.UnescapeString(match[1]))
		}
	}
	matches = mdImagePattern.FindAllStringSubmatch(block, -1)
	for _, match := range matches {
		if len(match) > 1 {
			urls = append(urls, html.UnescapeString(match[1]))
		}
	}
	return dedupe(urls)
}

func unique(matches [][]string) []string {
	values := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) > 1 {
			values = append(values, match[1])
		}
	}
	return dedupe(values)
}

func dedupe(values []string) []string {
	seen := make(map[string]bool, len(values))
	next := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		next = append(next, value)
	}
	return next
}

func isFeatured(markdown string, start int) bool {
	featuredIndex := strings.LastIndex(markdown[:start], "## 🔥 精选提示词")
	allIndex := strings.LastIndex(markdown[:start], "## 📋 所有提示词")
	return featuredIndex >= 0 && featuredIndex > allIndex
}

func stableID(no string, title string) string {
	sum := sha1.Sum([]byte(no + ":" + title))
	return "awesome-gpt-image-2-" + no + "-" + hex.EncodeToString(sum[:])[:10]
}

func detectCategory(title string, featured bool) string {
	if featured {
		return "精选"
	}
	if before, _, ok := strings.Cut(title, " - "); ok && strings.TrimSpace(before) != "" {
		return strings.TrimSpace(before)
	}
	categories := []string{
		"个人资料 / 头像", "社交媒体帖子", "信息图 / 教育视觉图", "YouTube 缩略图",
		"漫画 / 故事板", "产品营销", "电商主图", "游戏素材", "海报 / 传单", "App / 网页设计",
		"摄影", "电影 / 电影剧照", "动漫 / 漫画", "插画", "草图 / 线稿", "漫画 / 图画小说",
		"3D 渲染", "Q 版 / Q 萌风", "等距", "像素艺术", "油画", "水彩画", "水墨 / 中国风",
		"复古 / 怀旧", "赛博朋克 / 科幻", "极简主义", "人像 / 自拍", "网红 / 模特",
		"角色", "产品", "食品 / 饮料", "建筑 / 室内设计", "风景 / 自然", "文本 / 排版",
	}
	for _, category := range categories {
		if strings.Contains(title, category) {
			return category
		}
	}
	return "社区提示词"
}
