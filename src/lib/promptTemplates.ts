export interface PromptTemplate {
  id: string
  title: string
  prompt: string
  summary: string
  category: string
  tags: string[]
  imageUrl: string
  author: string
}

const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'cinematic-portrait-rain-night',
    title: '雨夜电影感人像',
    category: '人像摄影',
    summary: '适合生成霓虹雨夜中的电影质感半身人像，氛围强、肤色自然、画面有故事感。',
    prompt:
      '一位年轻亚洲女性站在雨夜城市街角，湿润柏油路反射霓虹灯光，电影感半身人像，35mm 胶片摄影，浅景深，自然肤色，细腻皮肤纹理，发丝带有雨滴，高对比但不过曝，背景有虚化的出租车和便利店灯牌，真实摄影质感，柔和轮廓光，情绪安静而坚定，8k，高细节',
    tags: ['人像', '电影感', '雨夜', '霓虹', '摄影'],
    imageUrl: '',
    author: 'ChainCloud',
  },
  {
    id: 'premium-skincare-product-poster',
    title: '高端护肤品海报',
    category: '产品海报',
    summary: '用于护肤品、电商主图和品牌广告，强调玻璃质感、水光、干净版式与高级商业摄影。',
    prompt:
      '高端护肤精华瓶产品广告海报，透明玻璃瓶身置于浅色石材台面，周围有水滴、柔和植物叶片和微弱金色反光，干净高级的商业摄影，顶部留出品牌标题空间，构图居中，柔和棚拍灯光，精致阴影，真实材质，清爽白色背景，极简奢华风格，超清细节，适合电商主图',
    tags: ['产品', '海报', '护肤品', '商业摄影', '电商'],
    imageUrl: '',
    author: 'ChainCloud',
  },
  {
    id: 'chinese-new-year-ip-character',
    title: '新年国潮 IP 角色',
    category: '角色设计',
    summary: '生成带有春节、国潮和潮玩质感的可爱 IP 角色，适合品牌吉祥物和节日视觉。',
    prompt:
      '可爱的国潮兔子 IP 角色设计，穿红色新年夹袄，金色祥云刺绣，手拿小灯笼，圆润潮玩比例，大眼睛，表情活泼，站姿正面三视图风格，细腻 3D 渲染，柔和工作室灯光，白色干净背景，春节氛围，红金配色，高级玩具质感，适合品牌吉祥物',
    tags: ['角色', '国潮', '春节', 'IP', '潮玩'],
    imageUrl: '',
    author: 'ChainCloud',
  },
  {
    id: 'saas-dashboard-hero-mockup',
    title: 'SaaS 仪表盘界面',
    category: '界面样机',
    summary: '适合生成现代 SaaS 数据看板或产品官网展示图，强调清晰层级和真实界面细节。',
    prompt:
      '现代 SaaS 数据分析仪表盘界面样机，深浅结合的专业后台 UI，大面积数据图表、表格、侧边导航、筛选器和状态卡片，布局紧凑清晰，信息层级明确，真实产品截图质感，精致间距，细线图标，蓝绿点缀色，放在轻微透视的笔记本电脑屏幕中，干净工作台背景，商业级产品视觉',
    tags: ['UI', 'SaaS', '仪表盘', '样机', '产品'],
    imageUrl: '',
    author: 'ChainCloud',
  },
  {
    id: 'food-photography-hotpot',
    title: '川味火锅美食摄影',
    category: '美食摄影',
    summary: '生成热气腾腾的火锅广告图，适合餐饮宣传、菜单封面和社媒内容。',
    prompt:
      '川味牛油火锅美食摄影，红油锅底翻滚冒热气，牛肉卷、毛肚、鸭血、豆皮和青菜摆盘丰富，桌面有蘸料碟和竹筷，暖色餐厅灯光，近景特写，油光诱人，真实食物质感，高级餐饮广告摄影，背景轻微虚化，画面热闹但干净，超清细节',
    tags: ['美食', '火锅', '摄影', '餐饮', '广告'],
    imageUrl: '',
    author: 'ChainCloud',
  },
  {
    id: 'interior-japanese-tea-room',
    title: '日式茶室室内设计',
    category: '空间设计',
    summary: '用于室内效果图和生活方式场景，强调木质、自然光与静谧空间氛围。',
    prompt:
      '现代日式茶室室内设计，浅色原木地板，榻榻米座位，低矮茶桌，纸质推拉门，窗外有竹影，自然晨光洒入室内，空间简洁安静，侘寂美学，柔和阴影，真实建筑摄影，广角但不畸变，高级家居杂志风格，细节干净，温暖而克制',
    tags: ['室内', '日式', '茶室', '空间', '家居'],
    imageUrl: '',
    author: 'ChainCloud',
  },
  {
    id: 'fantasy-landscape-floating-island',
    title: '奇幻浮空岛场景',
    category: '概念场景',
    summary: '生成宏大的奇幻世界观场景，适合游戏概念图、小说封面和世界观视觉。',
    prompt:
      '史诗奇幻浮空岛场景，巨大的岛屿漂浮在云海之上，瀑布从岛边坠落到雾气中，远处有古老城堡和发光水晶塔，黄昏金色阳光穿过云层，画面宏大，电影级概念艺术，丰富层次，精细岩石和植被，远景有飞鸟剪影，梦幻但真实，超宽画幅，高细节',
    tags: ['奇幻', '场景', '概念艺术', '游戏', '世界观'],
    imageUrl: '',
    author: 'ChainCloud',
  },
  {
    id: 'brand-logo-minimal-coffee',
    title: '精品咖啡品牌标志',
    category: '品牌设计',
    summary: '适合生成咖啡店、独立品牌或包装视觉方向，简洁、可识别、便于延展。',
    prompt:
      '精品咖啡品牌标志设计，品牌名为 AURORA COFFEE，简洁现代的字标结合抽象咖啡豆与晨光符号，黑白主视觉，少量暖金点缀，矢量标志风格，线条干净，比例平衡，适合门店招牌、杯套和包装印刷，白色背景，专业品牌设计展示',
    tags: ['品牌', 'Logo', '咖啡', '包装', '极简'],
    imageUrl: '',
    author: 'ChainCloud',
  },
]

const CATEGORY_LABELS: Record<string, string> = {
  人像摄影: '人像摄影',
  产品海报: '产品海报',
  角色设计: '角色设计',
  界面样机: '界面样机',
  美食摄影: '美食摄影',
  空间设计: '空间设计',
  概念场景: '概念场景',
  品牌设计: '品牌设计',
}

export function getPromptCategoryLabel(category: string) {
  return CATEGORY_LABELS[category] ?? category
}

export async function fetchPromptTemplates(): Promise<PromptTemplate[]> {
  return PROMPT_TEMPLATES
}
