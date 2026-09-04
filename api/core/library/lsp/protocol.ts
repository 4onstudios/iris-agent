export type JsonRpcId = number;

export type PendingRequestHandlers = {
  // eslint-disable-next-line no-unused-vars
  resolve: (value: unknown) => void;
  // eslint-disable-next-line no-unused-vars
  reject: (reason?: unknown) => void;
};

export type LspMessage = {
  id?: JsonRpcId;
  method?: string;
  result?: unknown;
  error?: {
    message?: string;
  };
};

export type LspPosition = {
  line: number;
  character: number;
};

export type LspSemanticLegend = {
  tokenTypes: string[];
  tokenModifiers: string[];
};

export type LspSemanticTokensResult = {
  resultId?: string;
  data?: number[];
};