const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://github.com/ConnorSawaya/overcode" : `https://${stage}.overcode.ai`,
  console: stage === "production" ? "https://overcode.ai/auth" : `https://${stage}.overcode.ai/auth`,
  email: "help@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/ConnorSawaya/overcode",
  discord: "https://github.com/ConnorSawaya/overcode/discussions",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
