export interface PayLogger {
  info(
    message: string,
    fields?: Readonly<Record<string, string | number>>,
  ): void;
  warn(
    message: string,
    fields?: Readonly<Record<string, string | number>>,
  ): void;
}

export const silentLogger: PayLogger = {
  info() {},
  warn() {},
};
