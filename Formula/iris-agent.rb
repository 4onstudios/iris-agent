class IrisAgent < Formula
  desc "Standalone coding-agent service and CLI with ACP support"
  homepage "https://github.com/4onstudios/iris-agent"
  url "https://registry.npmjs.org/@4onstudios/iris-agent/-/iris-agent-0.4.0.tgz"
  sha256 "35783103411b6b0814c2985fd9312951d55a8d32c6424c3a0121d71f7db7c4af"
  license "MIT"
  revision 3

  depends_on "node"

  preserve_rpath

  def install
    ENV["PATH"] = "#{formula_opt_bin("node")}:#{ENV["PATH"]}"

    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/iris-agent"
  end

  post_install_steps do
    on_macos do
      # Repair invalid npm native-library signatures after relocation.
      run "/usr/bin/find",
          args: ["{{libexec}}", "-type", "f", "(", "-name", "*.node", "-o", "-name", "*.dylib", ")",
                 "-exec", "/bin/sh", "-c", <<~SH, "sh", "{}", "+"],
                   for library do
                     if ! /usr/bin/codesign --verify "$library" 2>/dev/null; then
                       /usr/bin/codesign --force --sign - "$library" || exit 1
                     fi
                   done
                 SH
          writable_paths: ["."], writable_base: :libexec
    end
  end

  test do
    assert_match "Options", shell_output("#{bin}/iris-agent --help")
  end
end
