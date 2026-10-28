declare module "@deepseek-ai/dsh-typert-protocol" {
  export abstract class TypertRemoteService {
    protected constructor(ctx: object, serviceKey: string, options?: { namespace?: string });
  }
}
