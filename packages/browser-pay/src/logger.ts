/**
 * Injectable log sink. The package never writes to the console. Fields are
 * short strings the caller already considers safe to record. Card numbers
 * are masked before they reach a logger.
 */
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
