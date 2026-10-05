class IrisAgent < Formula
  desc "Standalone coding-agent service and CLI with ACP support"
  homepage "https://github.com/4onstudios/iris-agent"
  url "https://registry.npmjs.org/@4onstudios/iris-agent/-/iris-agent-0.4.0.tgz"
  sha256 "35783103411b6b0814c2985fd9312951d55a8d32c6424c3a0121d71f7db7c4af"
  license "MIT"
  revision 4

  depends_on "node"

  preserve_rpath

  def install
    ENV["PATH"] = "#{formula_opt_bin("node")}:#{ENV["PATH"]}"

    system "npm", "install", *std_npm_args, "--include=optional"
    (bin/"iris-agent").write <<~SH
      #!/bin/bash
      chat=false
      plain=false
      acp=false
      previous=""
      for arg in "$@"; do
        case "$arg" in
          --chat|-c|--chat=true) chat=true ;;
          --chat=false) chat=false ;;
          --acp|-a|--acp=true|--help|--version) acp=true ;;
          --chat-ui=plain) plain=true ;;
          --chat-ui=auto|--chat-ui=opentui) plain=false ;;
        esac
        if [ "$previous" = "--chat-ui" ]; then
          if [ "$arg" = "plain" ]; then plain=true; else plain=false; fi
        fi
        previous="$arg"
      done
      if $chat && ! $plain && ! $acp; then
        exec "#{formula_opt_bin("node")}/node" --experimental-ffi "#{libexec}/bin/iris-agent" "$@"
      fi
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/bin/iris-agent" "$@"
    SH
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

    (testpath/"fake-node").write "#!/bin/sh\nprintf '%s\\n' \"$@\"\n"
    (testpath/"fake-node").chmod 0755
    launcher = (bin/"iris-agent").read.gsub("#{formula_opt_bin("node")}/node", "#{testpath}/fake-node")
    (testpath/"launcher").write launcher
    (testpath/"launcher").chmod 0755
    ["--chat", "-c", "--chat --chat-ui opentui", "--chat --chat-ui=auto"].each do |args|
      assert_includes shell_output("#{testpath}/launcher #{args}").lines.map(&:strip), "--experimental-ffi"
    end
    ["--help", "--acp", "--chat --chat-ui plain", "--chat --chat-ui=plain",
     "--chat --acp", "--chat=false"].each do |args|
      refute_includes shell_output("#{testpath}/launcher #{args}").lines.map(&:strip), "--experimental-ffi"
    end

    cd libexec/"lib/node_modules/@4onstudios/iris-agent" do
      system "#{formula_opt_bin("node")}/node", "--experimental-ffi", "--input-type=module", "-e", <<~JS
        import { createTestRenderer } from "@opentui/core/testing";
        const test = await createTestRenderer({ width: 60, height: 15, consoleMode: "disabled" });
        await test.renderOnce();
        test.renderer.destroy();
      JS
    end
  end
end
