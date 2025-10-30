import nextra from 'nextra'

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.jsx',
  latex: true,
  defaultShowCopyCode: true,
})

export default withNextra({
  reactStrictMode: true,
  images: {
    unoptimized: false,
  },
})
