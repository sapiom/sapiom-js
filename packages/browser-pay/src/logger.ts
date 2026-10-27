export interface PayLogger {
  warn(
    message: string,
    fields?: Readonly<Record<string, string | number | boolean>>,
  ): void;
}

export const silentLogger: PayLogger = {
  warn() {},
};
