import type { ThemeConfig } from 'antd';

const shared: ThemeConfig = {
  token: {
    colorPrimary: 'var(--colorBrand)',
    colorInfo: 'var(--colorBrand)',
    colorSuccess: 'var(--colorOk)',
    colorWarning: 'var(--colorWarn)',
    colorError: 'var(--colorDanger)',
    fontFamily: 'var(--fontSans)',
    fontSize: 14,
    borderRadius: 14,
    borderRadiusLG: 20,
    borderRadiusSM: 10,
    controlHeight: 36,
    lineWidth: 1,
    boxShadow: 'var(--shadowSoft)',
    boxShadowSecondary: '0 4px 12px rgba(0,0,0,0.04)',
    motionDurationMid: '0.2s',
    motionEaseInOut: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  },
  components: {
    Card: { borderRadiusLG: 20, paddingLG: 24, headerFontSize: 13, headerFontSizeSM: 12 },
    Button: { borderRadius: 14, borderRadiusLG: 18, borderRadiusSM: 10, fontWeight: 600, primaryShadow: 'var(--shadowButton)' },
    Input: { borderRadius: 14, controlHeight: 36, activeShadow: '0 0 0 3px rgba(0,122,255,0.12)' },
    Select: { borderRadius: 14 },
    Modal: { borderRadiusLG: 20, titleFontSize: 17, fontWeightStrong: 700 },
    Tag: { borderRadiusSM: 100, defaultBg: 'rgba(0,0,0,0.04)' },
    Table: { borderRadiusLG: 20, headerBg: 'rgba(0,0,0,0.02)', headerColor: 'var(--colorTextSecondary)', headerSplitColor: 'transparent', headerBorderRadius: 12 },
    Spin: { dotSize: 28, dotSizeLG: 40 },
    Upload: { borderRadiusLG: 20 },
  },
};

export const antdTheme: ThemeConfig = { ...shared };
