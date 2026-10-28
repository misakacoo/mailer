import type { ThemeConfig } from 'antd';

/**
 * 设计令牌：与「VNRock 设计系统」逐值对齐。
 * 改主题只改这里，不要在页面里散落硬编码色值。
 */
export const tokens = {
  background: '#fafaf9',
  card: '#ffffff',
  secondary: '#f4f4f2',

  ink: '#1a1a18',
  foreground: '#41413b',
  muted: '#74746c',

  primary: '#a96510',
  primaryHover: '#8a520f',
  primarySoft: '#fdf1d9',

  destructive: '#bd2c32',
  destructiveDeep: '#96232a',
  destructiveSoft: '#fef2f2',

  warning: '#d97706',
  warningSoft: '#fffbeb',

  success: '#16a34a',
  successDeep: '#166534',
  successSoft: '#dcfce7',

  border: '#e6e6e3',
  borderStrong: '#d3d3ce',

  rowHover: '#f8f8f6',
} as const;

/**
 * 尺寸基准（唯一来源）。
 *
 * 之前的内边距是散落各页的硬编码：0 / 8 / 12 / 16 / 20 / 24 / 28 / 32 都有，
 * 于是相同层级的内容在不同页面看起来不是一套东西。这里一次性钉死：
 *
 *  - 页面容器 32×40，卡片内 24，表格单元格 24/14
 *  - 层级间距只有 4 档：8（元素内）、12（标题与内容）、24（同组卡片）、32（区块）
 *
 * 原则：**留白只从这四档里取**。需要更松的地方把整块往上提一级，
 * 而不是发明一个 18px。
 */
export const metrics = {
  /** 侧边栏与顶栏：两条轴线的固定高度，页面标题基线依赖它 */
  siderWidth: 216,
  headerHeight: 56,

  /** 页面容器：宽屏下居中，两侧始终留出呼吸空间 */
  pageMaxWidth: 1560,
  pagePaddingX: 40,
  pagePaddingY: 32,
  pageMinWidth: 960,

  cardPadding: 24,
  cardPaddingCompact: 20,
  cardRadius: 8,

  /** 表格：单元格自带留白，分割线因此能贯通到卡片边缘 */
  cellX: 24,
  cellY: 12,

  sectionGap: 32,
  groupGap: 24,
  gridGutter: 24,
  headerGap: 20,

  tight: 8,
  snug: 12,
} as const;

export const fontStack =
  "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

export const monoStack =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: tokens.primary,
    colorLink: tokens.primary,
    colorLinkHover: tokens.primaryHover,
    colorSuccess: tokens.success,
    colorWarning: tokens.warning,
    colorError: tokens.destructive,
    colorInfo: tokens.primary,

    colorText: tokens.foreground,
    colorTextHeading: tokens.ink,
    colorTextSecondary: tokens.muted,
    colorTextTertiary: tokens.muted,

    colorBorder: tokens.border,
    colorBorderSecondary: tokens.border,
    colorBgLayout: tokens.background,
    colorBgContainer: tokens.card,
    colorFillAlter: tokens.secondary,

    borderRadius: 6,
    borderRadiusLG: metrics.cardRadius,
    borderRadiusSM: 6,

    controlHeight: 36,
    controlHeightSM: 32,
    controlHeightLG: 40,

    fontFamily: fontStack,
    fontSize: 14,

    // 零阴影铁律：分层只用描边 + 面板色阶
    boxShadow: 'none',
    boxShadowSecondary: 'none',
    boxShadowTertiary: 'none',
    // 扁平语言下动效收益很低，直接关掉，弹层瞬间成型
    motion: false,
  },
  components: {
    Card: {
      headerHeight: 48,
      headerBg: tokens.card,
      // 卡片内边距是全局基准，页面里不要再覆盖它
      paddingLG: metrics.cardPadding,
      colorBorderSecondary: tokens.border,
    },
    Button: {
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      fontWeight: 500,
    },
    Table: {
      // 表头不用灰底：卡片里那条灰带会显得像贴上去的一块，
      // 白底 + 一条发丝下边框更干净，也和其他卡片的分层方式一致
      headerBg: 'transparent',
      headerColor: tokens.muted,
      headerSplitColor: 'transparent',
      borderColor: tokens.border,
      rowHoverBg: tokens.rowHover,
      // 单元格留白 = 卡片内边距，表格内容因此和页面其它内容左对齐
      cellPaddingBlock: metrics.cellY,
      cellPaddingInline: metrics.cellX,
      cellFontSize: 13,
      headerBorderRadius: 0,
    },
    Menu: {
      itemSelectedBg: tokens.primarySoft,
      itemSelectedColor: tokens.primary,
      itemColor: tokens.muted,
      itemHoverBg: tokens.secondary,
      itemHeight: 40,
      itemBorderRadius: 6,
      itemMarginInline: 0,
      iconSize: 16,
    },
    Segmented: {
      itemSelectedBg: tokens.card,
      trackBg: tokens.secondary,
    },
    Tag: { defaultBg: tokens.secondary, defaultColor: tokens.muted },
    Modal: { titleFontSize: 16, headerBg: tokens.card },
    Drawer: { footerPaddingBlock: 16 },
    Steps: { colorPrimary: tokens.primary },
    Progress: { defaultColor: tokens.primary, remainingColor: tokens.secondary },
    Descriptions: { labelBg: tokens.secondary },
    Form: { itemMarginBottom: 20, verticalLabelPadding: '0 0 6px' },
  },
};

/** 状态 → 浅底 + 深字（对比度够用，且不引入新色） */
export const statusStyles: Record<string, { bg: string; fg: string; label: string }> = {
  draft: { bg: tokens.secondary, fg: tokens.muted, label: '草稿' },
  scheduled: { bg: tokens.secondary, fg: tokens.primary, label: '已排期' },
  running: { bg: tokens.primarySoft, fg: tokens.primary, label: '发送中' },
  paused: { bg: tokens.warningSoft, fg: tokens.warning, label: '已暂停' },
  done: { bg: tokens.successSoft, fg: tokens.successDeep, label: '已完成' },
  canceled: { bg: tokens.secondary, fg: tokens.muted, label: '已取消' },

  queued: { bg: tokens.secondary, fg: tokens.muted, label: '待发送' },
  sending: { bg: tokens.primarySoft, fg: tokens.primary, label: '发送中' },
  sent: { bg: tokens.successSoft, fg: tokens.successDeep, label: '已送达' },
  failed: { bg: tokens.destructiveSoft, fg: tokens.destructiveDeep, label: '失败' },
  suppressed: { bg: tokens.destructiveSoft, fg: tokens.destructiveDeep, label: '地址不存在' },

  active: { bg: tokens.successSoft, fg: tokens.successDeep, label: '正常' },
  error: { bg: tokens.destructiveSoft, fg: tokens.destructiveDeep, label: '异常' },

  bounced: { bg: tokens.destructiveSoft, fg: tokens.destructiveDeep, label: '硬退信' },
  complained: { bg: tokens.destructiveSoft, fg: tokens.destructiveDeep, label: '投诉' },
};

export function statusOf(status: string) {
  return statusStyles[status] ?? { bg: tokens.secondary, fg: tokens.muted, label: status };
}
