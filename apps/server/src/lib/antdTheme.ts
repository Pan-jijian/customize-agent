import { theme } from 'antd';
import type { ThemeConfig } from 'antd';

export function getAntdTheme(isDark: boolean): ThemeConfig {
  return {
    algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: isDark ? '#0a84ff' : '#007aff',
      colorInfo: isDark ? '#0a84ff' : '#007aff',
      colorSuccess: isDark ? '#30d158' : '#34c759',
      colorWarning: isDark ? '#ff9f0a' : '#ff9500',
      colorError: isDark ? '#ff453a' : '#ff3b30',
      colorBgBase: isDark ? '#1c1c1e' : '#f5f5f7',
      colorBgContainer: isDark ? 'rgba(44,44,46,0.78)' : 'rgba(255,255,255,0.78)',
      colorBgElevated: isDark ? 'rgba(44,44,46,0.92)' : 'rgba(255,255,255,0.94)',
      colorBorder: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(60,60,67,0.16)',
      colorText: isDark ? '#f5f5f7' : '#1d1d1f',
      colorTextSecondary: isDark ? '#98989d' : '#6e6e73',
      fontFamily: 'var(--fontSans)',
      fontSize: 14,
      borderRadius: 14,
      borderRadiusLG: 20,
      borderRadiusSM: 10,
      controlHeight: 36,
      lineWidth: 1,
      boxShadow: isDark ? '0 8px 24px rgba(0,0,0,0.24)' : '0 8px 24px rgba(0,0,0,0.06)',
      boxShadowSecondary: isDark ? '0 4px 12px rgba(0,0,0,0.2)' : '0 4px 12px rgba(0,0,0,0.04)',
      motionDurationMid: '0.2s',
      motionEaseInOut: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
    },
    components: {
      Card: { borderRadiusLG: 20, paddingLG: 24, headerFontSize: 13, headerFontSizeSM: 12 },
      Button: { borderRadius: 14, borderRadiusLG: 18, borderRadiusSM: 10, fontWeight: 600, primaryShadow: 'var(--shadowButton)' },
      Input: { borderRadius: 14, controlHeight: 36, activeShadow: '0 0 0 3px rgba(0,122,255,0.12)' },
      Select: { borderRadius: 14 },
      Modal: { borderRadiusLG: 20, titleFontSize: 17, fontWeightStrong: 700 },
      Tag: { borderRadiusSM: 100, defaultBg: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)' },
      Table: { borderRadiusLG: 20, headerBg: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', headerColor: 'var(--colorTextSecondary)', headerSplitColor: 'transparent', headerBorderRadius: 12 },
      Spin: { dotSize: 28, dotSizeLG: 40 },
      Upload: { borderRadiusLG: 20 },
    },
  };
}
