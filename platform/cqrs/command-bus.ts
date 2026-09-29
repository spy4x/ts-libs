import { runMiddlewares } from "./middleware.ts"
import type {
  Command,
  CommandConstructor,
  CommandHandler,
  CommandResult,
  CqrsMiddleware,
} from "./types.ts"

/**
 * Routes a command instance to the one handler registered for its class, and infers the returned
 * value's type from the command class alone — no cast at the call site.
 *
 * Each `CommandBus` instance owns its own handler map (`new Map()` per instance); two instances
 * never share state, so a test can create a fresh bus per case with no risk of a handler from one
 * test leaking into another.
 *
 * @example
 * ```ts
 * class CreateUser implements Command<{ name: string }, { id: number }> {
 *   readonly __resultType?: { id: number }
 *   constructor(public data: { name: string }) {}
 * }
 *
 * const bus = new CommandBus()
 * bus.register(CreateUser, async (command) => ({ id: 1, ...command.data }))
 * const result = await bus.execute(new CreateUser({ name: "Ada" })) // { id: number }
 * ```
 */
export class CommandBus {
  private handlers: Map<
    CommandConstructor<Command<unknown, unknown>>,
    CommandHandler<Command<unknown, unknown>>
  > = new Map()

  private middlewares: CqrsMiddleware[] = []

  /**
   * Add `middleware` to every later `execute`. Middlewares run in registration order, the first
   * registered outermost, and all of them run before the handler. With none, `execute` calls the
   * handler directly. A dispatch already in progress keeps the list it started with.
   */
  use(middleware: CqrsMiddleware): void {
    this.middlewares.push(middleware)
  }

  /** Register `handler` as the one handler for `commandClass`. A second call replaces it. */
  register<T extends Command<unknown, unknown>>(
    commandClass: CommandConstructor<T>,
    handler: CommandHandler<T>,
  ): void {
    this.handlers.set(commandClass, handler as CommandHandler<Command<unknown, unknown>>)
  }

  /**
   * Run the handler registered for `command`'s class, through every middleware added with
   * {@link CommandBus.use}. Throws when no handler is registered, before any middleware runs.
   */
  async execute<T extends Command<unknown, unknown>>(command: T): Promise<CommandResult<T>> {
    const CommandClass = command.constructor as CommandConstructor<T>
    const handler = this.handlers.get(CommandClass)

    if (!handler) {
      throw new Error(`No handler registered for command: ${CommandClass.name}`)
    }

    return await runMiddlewares(
      [...this.middlewares],
      command,
      () => handler(command),
    ) as CommandResult<T>
  }

  /** Names of every command class with a registered handler, in registration order. */
  getRegisteredCommands(): string[] {
    return Array.from(this.handlers.keys()).map((cmd) => cmd.name)
  }
}
