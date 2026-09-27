import type { AppDatabase } from "../db/client";
import { createContext, invalid, type Executor } from "./repository-internals";
import { goalOperations } from "./goal-repository";
import { taskOperations } from "./task-repository";
import { planOperations } from "./plan-repository";
import { conversationOperations } from "./conversation-repository";
import { supportOperations } from "./support-repository";
import type { NonThenable, Repositories, RepositoryUnitOfWork, TransactionRepositories } from "./repository-types";
function operations(executor: Executor): TransactionRepositories {
  const ctx = createContext(executor);
  return {
    goals: goalOperations(ctx), tasks: taskOperations(ctx), plans: planOperations(ctx), conversations: conversationOperations(ctx), support: supportOperations(ctx)
  };
}
const names = ["goals", "tasks", "plans", "conversations", "support"] as const;
type DynamicMethods = Record<string, (...args: unknown[]) => unknown>;
type RepositoryName = (typeof names)[number];

function wrapMethods(
  source: TransactionRepositories,
  invoke: (name: RepositoryName, method: string, args: unknown[]) => unknown,
) {
  const wrapped: Record<string, DynamicMethods> = {};
  for (const name of names) {
    const methods: DynamicMethods = {};
    for (const method of Object.keys(source[name])) {
      methods[method] = (...args) => invoke(name, method, args);
    }
    wrapped[name] = methods;
  }
  return wrapped;
}

/** Sole public construction point. No executor or private stores escape this boundary. */
export function createRepositories(database: AppDatabase): Repositories & RepositoryUnitOfWork {
  let inCallback = false;
  const withTransaction: RepositoryUnitOfWork["withTransaction"] = async <T>(callback: (repositories: TransactionRepositories) => T & NonThenable<T>): Promise<T> => {
    // Outer Promise adapters cannot be composed inside a synchronous unit of work.
    if (inCallback)
      invalid();
    return database.transaction(executor => {
      let active = true;
      const facade = wrapMethods(operations(executor), (name, method, args) => {
        if (!active) invalid();
        // A caught method error must not leave partial work in the outer transaction.
        return executor.transaction(nested => {
          const methods = operations(nested)[name] as unknown as DynamicMethods;
          return methods[method](...args);
        });
      }) as unknown as TransactionRepositories;
      try {
        inCallback = true;
        const result = callback(facade);
        if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as {
          then?: unknown;
        }).then === "function") {
          // Observe the late rejection without awaiting or keeping the facade alive.
          void Promise.resolve(result).catch(() => undefined);
          invalid();
        }
        return result;
      }
      finally {
        active = false;
        inCallback = false;
      }
    });
  };
  // These adapters preserve each declared argument/result type; only this private
  // iteration bridge erases the heterogeneous method signatures.
  const publicRepositories = wrapMethods(operations(database), (name, method, args) =>
    withTransaction(tx => (tx[name] as unknown as DynamicMethods)[method](...args)),
  ) as unknown as Repositories;
  return {
    ...publicRepositories, withTransaction
  };
}
