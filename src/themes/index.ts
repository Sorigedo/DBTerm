import type { ITheme } from '@xterm/xterm'

export interface ThemeDef {
  key: string
  name: string
  mode: 'dark' | 'light'
  xterm: ITheme
  preview: {
    bg: string
    fg: string
    swatches: string[]
  }
}

export const THEMES: Record<string, ThemeDef> = {
  // ── Dark Themes ─────────────────────────────────────────
  tokyoNight: {
    key: 'tokyoNight', name: 'Tokyo Night', mode: 'dark',
    xterm: {
      background: '#1a1b26', foreground: '#8890b2',
      cursor: '#c0caf5', cursorAccent: '#1a1b26',
      selectionBackground: '#283457',
      black: '#32344a', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#ad8ee6', cyan: '#449dab', white: '#787c99',
      brightBlack: '#444b6a', brightRed: '#ff7a93', brightGreen: '#b9f27c',
      brightYellow: '#ff9e64', brightBlue: '#7da6ff', brightMagenta: '#bb9af7',
      brightCyan: '#0db9d7', brightWhite: '#acb0d0',
    },
    preview: { bg: '#1a1b26', fg: '#8890b2', swatches: ['#f7768e','#9ece6a','#e0af68','#7aa2f7','#ad8ee6','#449dab'] },
  },

  dracula: {
    key: 'dracula', name: 'Dracula', mode: 'dark',
    xterm: {
      // 原 fg #f8f8f2 接近纯白（对比度约 20:1），改为柔和薰衣草灰（约 9:1）
      background: '#282a36', foreground: '#bbc2e0',
      cursor: '#cdd6f4', cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    preview: { bg: '#282a36', fg: '#bbc2e0', swatches: ['#ff5555','#50fa7b','#f1fa8c','#bd93f9','#ff79c6','#8be9fd'] },
  },

  nord: {
    key: 'nord', name: 'Nord', mode: 'dark',
    xterm: {
      // 原 fg #d8dee9（约 9:1），改为柔和北欧蓝灰（约 6.5:1）
      background: '#2e3440', foreground: '#bbc4d1',
      cursor: '#d8dee9', cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    preview: { bg: '#2e3440', fg: '#bbc4d1', swatches: ['#bf616a','#a3be8c','#ebcb8b','#81a1c1','#b48ead','#88c0d0'] },
  },

  catppuccin: {
    key: 'catppuccin', name: 'Catppuccin Mocha', mode: 'dark',
    xterm: {
      // 原 fg #cdd6f4（约 8:1），改为 Catppuccin subtext0 #bac2de（约 7.3:1）
      background: '#1e1e2e', foreground: '#bac2de',
      cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
      selectionBackground: '#313244',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
    preview: { bg: '#1e1e2e', fg: '#bac2de', swatches: ['#f38ba8','#a6e3a1','#f9e2af','#89b4fa','#f5c2e7','#94e2d5'] },
  },

  oneDark: {
    key: 'oneDark', name: 'One Dark Pro', mode: 'dark',
    xterm: {
      background: '#282c34', foreground: '#9099a5',
      cursor: '#528bff', cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
      brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
      brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
    preview: { bg: '#282c34', fg: '#9099a5', swatches: ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2'] },
  },

  gruvbox: {
    key: 'gruvbox', name: 'Gruvbox Dark', mode: 'dark',
    xterm: {
      // 原 fg #ebdbb2（约 10:1 暖米黄），改为偏暗暖灰（约 6.9:1）
      background: '#282828', foreground: '#d5c9a0',
      cursor: '#ebdbb2', cursorAccent: '#282828',
      selectionBackground: '#3c3836',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
      brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
      brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
    preview: { bg: '#282828', fg: '#d5c9a0', swatches: ['#fb4934','#b8bb26','#fabd2f','#83a598','#d3869b','#8ec07c'] },
  },

  monokai: {
    key: 'monokai', name: 'Monokai', mode: 'dark',
    xterm: {
      // 原 fg #f8f8f2（近纯白，约 18:1），改为暖中灰（约 7.4:1）
      background: '#272822', foreground: '#c8c8c4',
      cursor: '#f8f8f0', cursorAccent: '#272822',
      selectionBackground: '#49483e',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
      brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
    preview: { bg: '#272822', fg: '#c8c8c4', swatches: ['#f92672','#a6e22e','#f4bf75','#66d9ef','#ae81ff','#a1efe4'] },
  },

  rosePine: {
    key: 'rosePine', name: 'Rosé Pine', mode: 'dark',
    xterm: {
      // 原 fg #e0def4（约 11:1），改为柔和薰衣草灰（约 8:1）
      background: '#191724', foreground: '#c8c6dc',
      cursor: '#e0def4', cursorAccent: '#191724',
      selectionBackground: '#26233a',
      black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177',
      blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f',
      brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7',
      brightCyan: '#ebbcba', brightWhite: '#e0def4',
    },
    preview: { bg: '#191724', fg: '#c8c6dc', swatches: ['#eb6f92','#31748f','#f6c177','#9ccfd8','#c4a7e7','#ebbcba'] },
  },

  solarizedDark: {
    key: 'solarizedDark', name: 'Solarized Dark', mode: 'dark',
    xterm: {
      background: '#002b36', foreground: '#839496',
      cursor: '#839496', cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
    preview: { bg: '#002b36', fg: '#839496', swatches: ['#dc322f','#859900','#b58900','#268bd2','#d33682','#2aa198'] },
  },

  ayu: {
    key: 'ayu', name: 'Ayu Dark', mode: 'dark',
    xterm: {
      background: '#0d1117', foreground: '#8c8a86',
      cursor: '#e6b450', cursorAccent: '#0d1117',
      selectionBackground: '#1c2128',
      black: '#01060e', red: '#ea6c73', green: '#91b362', yellow: '#f9af4f',
      blue: '#53bdfa', magenta: '#fae994', cyan: '#90e1c6', white: '#c7c7c7',
      brightBlack: '#686868', brightRed: '#f07178', brightGreen: '#c2d94c',
      brightYellow: '#ffb454', brightBlue: '#59c2ff', brightMagenta: '#ffee99',
      brightCyan: '#95e6cb', brightWhite: '#ffffff',
    },
    preview: { bg: '#0d1117', fg: '#8c8a86', swatches: ['#ea6c73','#91b362','#f9af4f','#53bdfa','#fae994','#90e1c6'] },
  },

  // ── Light Themes ─────────────────────────────────────────
  solarizedLight: {
    key: 'solarizedLight', name: 'Solarized Light', mode: 'light',
    xterm: {
      background: '#fdf6e3', foreground: '#586e75',
      cursor: '#268bd2', cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#93a1a1',
      // brightBlack 改为 base1（#93a1a1），明显比 foreground 浅，用于时间戳/debug 着灰
      brightBlack: '#93a1a1', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#2aa198', brightWhite: '#fdf6e3',
    },
    preview: { bg: '#fdf6e3', fg: '#586e75', swatches: ['#dc322f','#859900','#b58900','#268bd2','#d33682','#2aa198'] },
  },

  githubLight: {
    key: 'githubLight', name: 'GitHub Light', mode: 'light',
    xterm: {
      // 背景改为 GitHub 实际用的淡灰（#f6f8fa），正文软化（原 #24292e 对比度 16:1 太刺）
      background: '#f6f8fa', foreground: '#444d56',
      cursor: '#044289', cursorAccent: '#f6f8fa',
      selectionBackground: '#c8c8fa',
      black: '#24292e', red: '#d73a49', green: '#22863a', yellow: '#b08800',
      blue: '#0366d6', magenta: '#5a32a3', cyan: '#1b7c83', white: '#6a737d',
      brightBlack: '#959da5', brightRed: '#cb2431', brightGreen: '#28a745',
      brightYellow: '#dbab09', brightBlue: '#2188ff', brightMagenta: '#8a63d2',
      brightCyan: '#3192aa', brightWhite: '#d1d5da',
    },
    preview: { bg: '#f6f8fa', fg: '#444d56', swatches: ['#d73a49','#22863a','#b08800','#0366d6','#5a32a3','#1b7c83'] },
  },

  catppuccinLatte: {
    key: 'catppuccinLatte', name: 'Catppuccin Latte', mode: 'light',
    xterm: {
      background: '#eff1f5', foreground: '#4c4f69',
      cursor: '#dc8a78', cursorAccent: '#eff1f5',
      selectionBackground: '#acb0be',
      black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
      blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be',
      brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b',
      brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#ea76cb',
      brightCyan: '#179299', brightWhite: '#bcc0cc',
    },
    preview: { bg: '#eff1f5', fg: '#4c4f69', swatches: ['#d20f39','#40a02b','#df8e1d','#1e66f5','#ea76cb','#179299'] },
  },

  oneLight: {
    key: 'oneLight', name: 'One Light', mode: 'light',
    xterm: {
      // 原 fg #383a42（约 12:1），软化到约 8:1
      background: '#fafafa', foreground: '#4c4f5a',
      cursor: '#526fff', cursorAccent: '#fafafa',
      selectionBackground: '#e5e5e6',
      black: '#696c77', red: '#e45649', green: '#50a14f', yellow: '#c18401',
      blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7',
      // 原值 #383a42 与 foreground 完全相同，时间戳/debug 无法变灰；改为中性灰
      brightBlack: '#9d9fa3', brightRed: '#ca1243', brightGreen: '#50a14f',
      brightYellow: '#986801', brightBlue: '#4078f2', brightMagenta: '#a626a4',
      brightCyan: '#0184bc', brightWhite: '#fafafa',
    },
    preview: { bg: '#fafafa', fg: '#4c4f5a', swatches: ['#e45649','#50a14f','#c18401','#4078f2','#a626a4','#0184bc'] },
  },

  ayuLight: {
    key: 'ayuLight', name: 'Ayu Light', mode: 'light',
    xterm: {
      background: '#fafafa', foreground: '#575f66',
      cursor: '#ff9940', cursorAccent: '#fafafa',
      selectionBackground: '#d1d8e0',
      black: '#0a0e14', red: '#ff3333', green: '#86b300', yellow: '#f29718',
      blue: '#36a3d9', magenta: '#a37acc', cyan: '#4dbf99', white: '#c7c7c7',
      brightBlack: '#686868', brightRed: '#f07178', brightGreen: '#c2d94c',
      brightYellow: '#ffb454', brightBlue: '#59c2ff', brightMagenta: '#ffee99',
      brightCyan: '#95e6cb', brightWhite: '#ffffff',
    },
    preview: { bg: '#fafafa', fg: '#575f66', swatches: ['#ff3333','#86b300','#f29718','#36a3d9','#a37acc','#4dbf99'] },
  },

  // ── 冷色 / 清爽浅色主题（避免发黄发暖）────────────────────────────
  tokyoNightLight: {
    key: 'tokyoNightLight', name: 'Tokyo Night Light', mode: 'light',
    xterm: {
      background: '#e1e2e7', foreground: '#3760bf',
      cursor: '#3760bf', cursorAccent: '#e1e2e7',
      selectionBackground: '#b6bfe2',
      black: '#0f0f14', red: '#8c4351', green: '#33635c', yellow: '#8f5e15',
      blue: '#34548a', magenta: '#5a4a78', cyan: '#0f4b6e', white: '#6172b0',
      brightBlack: '#9699a3', brightRed: '#8c4351', brightGreen: '#33635c',
      brightYellow: '#8f5e15', brightBlue: '#2e7de9', brightMagenta: '#5a4a78',
      brightCyan: '#007197', brightWhite: '#3760bf',
    },
    preview: { bg: '#e1e2e7', fg: '#3760bf', swatches: ['#8c4351','#33635c','#8f5e15','#34548a','#5a4a78','#0f4b6e'] },
  },

  nordLight: {
    key: 'nordLight', name: 'Nord Light', mode: 'light',
    xterm: {
      // 原 fg #2e3440（约 13:1），软化到约 8.5:1
      background: '#eceff4', foreground: '#3b4a5a',
      cursor: '#5e81ac', cursorAccent: '#eceff4',
      selectionBackground: '#d8dee9',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#d08770',
      blue: '#5e81ac', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
      brightYellow: '#d08770', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    preview: { bg: '#eceff4', fg: '#3b4a5a', swatches: ['#bf616a','#a3be8c','#d08770','#5e81ac','#b48ead','#88c0d0'] },
  },

  materialLighter: {
    key: 'materialLighter', name: 'Material Lighter', mode: 'light',
    xterm: {
      background: '#fafafa', foreground: '#546e7a',
      cursor: '#272727', cursorAccent: '#fafafa',
      selectionBackground: '#e7e7e8',
      black: '#000000', red: '#e53935', green: '#91b859', yellow: '#f6a434',
      blue: '#6182b8', magenta: '#7c4dff', cyan: '#39adb5', white: '#a7adb0',
      // 原值 #cccccc 在白底对比度极低（几乎看不见）；改为 Material Blue Grey 500
      brightBlack: '#78909c', brightRed: '#e53935', brightGreen: '#91b859',
      brightYellow: '#e65100', brightBlue: '#6182b8', brightMagenta: '#7c4dff',
      brightCyan: '#39adb5', brightWhite: '#ffffff',
    },
    preview: { bg: '#fafafa', fg: '#546e7a', swatches: ['#e53935','#91b859','#f6a434','#6182b8','#7c4dff','#39adb5'] },
  },

  quietLight: {
    key: 'quietLight', name: 'Quiet Light', mode: 'light',
    xterm: {
      // 原 fg #333333（约 12:1），软化到约 8:1
      background: '#f5f5f5', foreground: '#4a4a4a',
      cursor: '#54494b', cursorAccent: '#f5f5f5',
      selectionBackground: '#c9d0d9',
      black: '#000000', red: '#ad2bee', green: '#448c27', yellow: '#cb9000',
      blue: '#4b69c6', magenta: '#7a3e9d', cyan: '#0e7c7b', white: '#dddddd',
      brightBlack: '#777777', brightRed: '#ad2bee', brightGreen: '#448c27',
      brightYellow: '#cb9000', brightBlue: '#4b69c6', brightMagenta: '#7a3e9d',
      brightCyan: '#0e7c7b', brightWhite: '#ffffff',
    },
    preview: { bg: '#f5f5f5', fg: '#4a4a4a', swatches: ['#ad2bee','#448c27','#cb9000','#4b69c6','#7a3e9d','#0e7c7b'] },
  },

  minLight: {
    key: 'minLight', name: 'Min Light', mode: 'light',
    xterm: {
      // 原 fg #383838（约 11:1），软化到约 8:1
      background: '#f9f9f9', foreground: '#4a4a4a',
      cursor: '#2f6fdb', cursorAccent: '#f9f9f9',
      selectionBackground: '#d7e6ff',
      black: '#2e2e2e', red: '#dd5c63', green: '#3d9c63', yellow: '#b58900',
      blue: '#2f6fdb', magenta: '#9a5cb5', cyan: '#1a9b9b', white: '#bfbfbf',
      brightBlack: '#7a7a7a', brightRed: '#dd5c63', brightGreen: '#3d9c63',
      brightYellow: '#b58900', brightBlue: '#2f6fdb', brightMagenta: '#9a5cb5',
      brightCyan: '#1a9b9b', brightWhite: '#f9f9f9',
    },
    preview: { bg: '#f9f9f9', fg: '#4a4a4a', swatches: ['#dd5c63','#3d9c63','#b58900','#2f6fdb','#9a5cb5','#1a9b9b'] },
  },

  iceberg: {
    key: 'iceberg', name: 'Iceberg Light', mode: 'light',
    xterm: {
      background: '#e8e9ec', foreground: '#33374c',
      cursor: '#33374c', cursorAccent: '#e8e9ec',
      selectionBackground: '#c2c5cf',
      black: '#dcdfe7', red: '#cc517a', green: '#668e3d', yellow: '#c57339',
      blue: '#2d539e', magenta: '#7759b4', cyan: '#3f83a6', white: '#33374c',
      brightBlack: '#8389a3', brightRed: '#cc3768', brightGreen: '#598030',
      brightYellow: '#b6662d', brightBlue: '#22478e', brightMagenta: '#6845ad',
      brightCyan: '#327698', brightWhite: '#262a3f',
    },
    preview: { bg: '#e8e9ec', fg: '#33374c', swatches: ['#cc517a','#668e3d','#c57339','#2d539e','#7759b4','#3f83a6'] },
  },
}

export const THEME_LIST = Object.values(THEMES)

// ── 终端 ANSI 字体配色方案（16 色，覆盖界面主题的 ANSI 部分）────────────────────
// 仅定义 16 个 ANSI 颜色（不含 background/foreground/cursor），
// 用于在不更换界面主题的前提下独立切换终端字体配色。
export interface AnsiPalette {
  key: string
  name: string
  hint: string   // 适用场景提示
  colors: {
    black: string; red: string; green: string; yellow: string
    blue: string; magenta: string; cyan: string; white: string
    brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string
    brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string
  }
}

export const ANSI_PALETTES: AnsiPalette[] = [
  {
    key: 'dracula', name: 'Dracula', hint: '深色主题',
    colors: {
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    key: 'tokyoNight', name: 'Tokyo Night', hint: '深色主题',
    colors: {
      black: '#1d202f', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#ff899d', brightGreen: '#b0f56b',
      brightYellow: '#fac769', brightBlue: '#a3c0ff', brightMagenta: '#c8a6ff',
      brightCyan: '#9de3ff', brightWhite: '#c0caf5',
    },
  },
  {
    key: 'catppuccin', name: 'Catppuccin', hint: '深色主题',
    colors: {
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#cba6f7', cyan: '#89dceb', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
      brightCyan: '#89dceb', brightWhite: '#a6adc8',
    },
  },
  {
    key: 'nord', name: 'Nord', hint: '深/浅色通用',
    colors: {
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  {
    key: 'classic', name: '经典终端', hint: '深/浅色通用',
    colors: {
      black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
      blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234',
      brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8',
      brightCyan: '#34e2e2', brightWhite: '#eeeeec',
    },
  },
  {
    key: 'solarized', name: 'Solarized', hint: '深/浅色通用',
    colors: {
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#93a1a1', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#2aa198', brightWhite: '#fdf6e3',
    },
  },
]
export type ThemeKey = keyof typeof THEMES

// ── 由主题色推导整套 UI CSS 变量（全软件换肤）────────────────────────
function clamp(n: number) { return Math.max(0, Math.min(255, Math.round(n))) }
function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('')
}
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseHex(a), [r2, g2, b2] = parseHex(b)
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
}
const lighten = (c: string, t: number) => mix(c, '#ffffff', t)
const darken  = (c: string, t: number) => mix(c, '#000000', t)
function alpha(c: string, a: number): string {
  const [r, g, b] = parseHex(c)
  return `rgba(${r},${g},${b},${a})`
}

/**
 * 从主题的终端色 + 深/浅模式推导出整套界面 CSS 变量。
 * 深色：面板在背景上「提亮」分层；浅色：背景压成浅灰画布、面板回到主题原色（近白）以形成层次，
 * 避免「通体灰、无层次」。强调/语义色取自主题调色板，让每套主题界面观感各异。
 */
export function buildThemeVars(t: ThemeDef): Record<string, string> {
  const x = t.xterm
  const B = x.background || '#0d1117'
  const F = x.foreground || '#e6edf3'
  const dark = t.mode === 'dark'
  const accent  = x.blue || x.brightBlue || '#2f81f7'
  const accentH = x.brightBlue || x.blue || accent
  return {
    // 浅色：画布只比面板略暗一点点（避免「边栏发灰、与白色编辑区割裂」），分区主要靠边框；
    // 输入/悬停/选中仍有足够灰阶对比。深色：面板在背景上提亮分层。
    '--bg':             dark ? B                : darken(B, 0.014),
    '--surface':        dark ? lighten(B, 0.045): B,
    '--surface-2':      dark ? lighten(B, 0.085): darken(B, 0.045),
    '--bg-raw':         dark ? B                : darken(B, 0.014),
    '--surface-raw':    dark ? lighten(B, 0.045): B,
    '--surface-2-raw':  dark ? lighten(B, 0.085): darken(B, 0.045),
    '--surface-hover':  dark ? lighten(B, 0.065): darken(B, 0.035),
    '--surface-active': dark ? lighten(B, 0.12) : darken(B, 0.07),
    '--border':         dark ? lighten(B, 0.15) : darken(B, 0.12),
    '--border-subtle':  dark ? lighten(B, 0.08) : darken(B, 0.06),
    '--text':           F,
    '--text-bright':    dark ? lighten(F, 0.18) : darken(F, 0.28),
    '--text-muted':     mix(F, B, 0.42),
    '--accent':         accent,
    '--accent-hover':   accentH,
    '--accent-glow':    alpha(accent, 0.30),
    '--accent-bg':      alpha(accent, dark ? 0.16 : 0.10),
    '--success':        x.green  || '#3fb950',
    '--warning':        x.yellow || '#d29922',
    '--error':          x.red    || '#f85149',
    '--error-bg':       alpha(x.red || '#f85149', dark ? 0.12 : 0.08),
  }
}
