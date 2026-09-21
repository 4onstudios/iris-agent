import { Marked, type MarkedExtension, type Tokens } from "marked";
import { markedTerminal } from "marked-terminal";

export const renderCliMarkdown = (
  markdown: string,
  columns = process.stdout.columns,
): string => {
  const renderer = markedTerminal({
    reflowText: true,
    width: typeof columns === "number" && columns > 0 ? columns : 80,
  }) as unknown as MarkedExtension;
  const nestedInlineFormatting: MarkedExtension = {
    renderer: {
      text(token: Tokens.Text | Tokens.Escape) {
        if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
          return this.parser.parseInline(token.tokens);
        }

        return false;
      },
    },
  };
  const parser = new Marked(renderer, nestedInlineFormatting);

  return parser.parse(markdown, { async: false, gfm: true });
};
