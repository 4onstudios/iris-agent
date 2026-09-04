import { EventEmitter } from "events";

const COPILOT_LANGUAGE_SERVER_FLAG = "IRIS_ENABLE_COPILOT_LANGUAGE_SERVER";

export class ExtensionManager extends EventEmitter {
  private copilotLanguageServerEnabled: boolean;

  constructor() {
    super();
    this.copilotLanguageServerEnabled = process.env[COPILOT_LANGUAGE_SERVER_FLAG] === "true";
  }

  isCopilotLanguageServerEnabled(): boolean {
    return this.copilotLanguageServerEnabled;
  }

  setCopilotLanguageServerEnabled(enabled: boolean): void {
    if (this.copilotLanguageServerEnabled === enabled) {
      return;
    }

    this.copilotLanguageServerEnabled = enabled;
    this.emit("change");
  }

  onDidChange(listener: () => void): () => void {
    this.on("change", listener);

    return () => {
      this.off("change", listener);
    };
  }
}

export const extensionManager = new ExtensionManager();

export default ExtensionManager;