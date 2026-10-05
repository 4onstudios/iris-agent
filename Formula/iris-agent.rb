class IrisAgent < Formula
  desc "Standalone coding-agent service and CLI with ACP support"
  homepage "https://github.com/4onstudios/iris-agent"
  url "https://registry.npmjs.org/@4onstudios/iris-agent/-/iris-agent-0.4.0.tgz"
  sha256 "35783103411b6b0814c2985fd9312951d55a8d32c6424c3a0121d71f7db7c4af"
  license "MIT"
  revision 2

  depends_on "node"

  def install
    ENV["PATH"] = "#{formula_opt_bin("node")}:#{ENV["PATH"]}"

    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/iris-agent"
  end

  def post_install
    return unless OS.mac?

    # npm native libraries can arrive with invalid linker signatures.
    # Repair after Homebrew relocation, preserving valid vendor signatures.
    libexec.glob("**/*.{node,dylib}").each do |library|
      next if quiet_system("/usr/bin/codesign", "--verify", library)

      system "/usr/bin/codesign", "--force", "--sign", "-", library
    end
  end

  test do
    assert_match "Options", shell_output("#{bin}/iris-agent --help")
  end
end
