export interface SmtpPreset {
  key: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  hint: string;
}

/** 常见服务商预设：选中后自动填 host/port/加密方式，减少手工出错 */
export const SMTP_PRESETS: SmtpPreset[] = [
  {
    key: 'qq',
    label: 'QQ 邮箱',
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    hint: '必须使用「授权码」，不是 QQ 登录密码；设置 → 账户 → 开启 SMTP 服务',
  },
  {
    key: 'exmail',
    label: '腾讯企业邮',
    host: 'smtp.exmail.qq.com',
    port: 465,
    secure: true,
    hint: '可用邮箱密码或客户端专用密码；企业邮日发限额比个人邮箱高得多',
  },
  {
    key: '163',
    label: '网易 163',
    host: 'smtp.163.com',
    port: 465,
    secure: true,
    hint: '必须使用「授权码」，在邮箱设置里开启 SMTP 后获取',
  },
  {
    key: '126',
    label: '网易 126',
    host: 'smtp.126.com',
    port: 465,
    secure: true,
    hint: '必须使用「授权码」',
  },
  {
    key: 'aliyun',
    label: '阿里企业邮',
    host: 'smtp.qiye.aliyun.com',
    port: 465,
    secure: true,
    hint: '用邮箱密码；域名需先完成邮箱解析',
  },
  {
    key: 'gmail',
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    hint: '需要「应用专用密码」，且账号需开启两步验证',
  },
  {
    key: 'outlook',
    label: 'Outlook / Microsoft 365',
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    hint: '用 587 + STARTTLS；部分租户默认关闭 SMTP AUTH，需要在后台开启',
  },
  {
    key: 'stackmail',
    label: 'Hostinger / Stackmail',
    host: 'smtp.stackmail.com',
    port: 465,
    secure: true,
    hint: '用邮箱账号的完整密码；本系统当前主力通道',
  },
  {
    key: 'custom',
    label: '自定义',
    host: '',
    port: 465,
    secure: true,
    hint: '手动填写 SMTP 服务器、端口与加密方式',
  },
];
