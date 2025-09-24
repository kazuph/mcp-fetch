declare module "applescript" {
  export function execString(
    script: string,
    callback: (err: Error | null, result: unknown) => void
  ): void;
}

declare module "robots-parser" {
  interface RobotsParser {
    isAllowed(url: string, userAgent: string): boolean;
  }
  export default function (robotsUrl: string, robotsTxt: string): RobotsParser;
}
