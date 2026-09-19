class IrisAgent < Formula
  desc "Standalone coding-agent service and CLI with ACP support"
  homepage "https://github.com/4onstudios/iris-agent"
  url "https://registry.npmjs.org/@4onstudios/iris-agent/-/iris-agent-0.2.3.tgz"
  sha256 "b50c0b53296e762e98dbc65c451724f9d0b7490cc368db410a79d4436b2b5fb8"
  license "MIT"

  depends_on "node@22"

  def install
    ENV["PATH"] = "#{formula_opt_bin("node@22")}:#{ENV["PATH"]}"

    system "npm", "install", *std_npm_args, url
    bin.install_symlink libexec/"bin/iris-agent"
    bin.install_symlink libexec/"bin/iris-agent-install-browser"
  end

  test do
    assert_match "Options", shell_output("#{bin}/iris-agent --help")
  end
end
