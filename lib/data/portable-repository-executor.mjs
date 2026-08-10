import { DatabaseProvider, DATABASE_DIALECTS, assertDatabaseProvider } from "./database-provider.mjs";

export function rewriteQuestionMarkPlaceholders(text, dialect) {
  const sql = String(text || "");
  if (dialect !== DATABASE_DIALECTS.POSTGRESQL || !sql.includes("?")) return sql;

  let result = "";
  let index = 0;
  let placeholder = 0;
  let state = "code";
  let dollarTag = "";

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === "single") {
      result += character;
      if (character === "'" && next === "'") {
        result += next;
        index += 2;
        continue;
      }
      if (character === "'") state = "code";
      index += 1;
      continue;
    }

    if (state === "double") {
      result += character;
      if (character === '"' && next === '"') {
        result += next;
        index += 2;
        continue;
      }
      if (character === '"') state = "code";
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      result += character;
      if (character === "\n") state = "code";
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      result += character;
      if (character === "*" && next === "/") {
        result += next;
        index += 2;
        state = "code";
        continue;
      }
      index += 1;
      continue;
    }

    if (state === "dollar") {
      if (sql.startsWith(dollarTag, index)) {
        result += dollarTag;
        index += dollarTag.length;
        state = "code";
        continue;
      }
      result += character;
      index += 1;
      continue;
    }

    if (character === "'") {
      state = "single";
      result += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      state = "double";
      result += character;
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      state = "line-comment";
      result += "--";
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      result += "/*";
      index += 2;
      continue;
    }
    if (character === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        state = "dollar";
        result += dollarTag;
        index += dollarTag.length;
        continue;
      }
    }
    if (character === "?") {
      placeholder += 1;
      result += `$${placeholder}`;
      index += 1;
      continue;
    }
    result += character;
    index += 1;
  }

  return result;
}

class PortableTransactionExecutor {
  constructor({ executor, dialect }) {
    this.executor = executor;
    this.dialect = dialect;
  }

  query(text, parameters = []) {
    return this.executor.query(rewriteQuestionMarkPlaceholders(text, this.dialect), parameters);
  }

  execute(text, parameters = []) {
    return this.executor.execute(rewriteQuestionMarkPlaceholders(text, this.dialect), parameters);
  }

  executeScript(text) {
    return this.executor.executeScript(text);
  }

  placeholder(index) {
    return this.executor.placeholder(index);
  }
}

export class PortableRepositoryExecutor extends DatabaseProvider {
  constructor({ provider }) {
    const resolved = assertDatabaseProvider(provider);
    super({ dialect: resolved.dialect });
    this.provider = resolved;
  }

  get connection() {
    return this.provider.connection;
  }

  get transactionManager() {
    return this.provider.transactionManager;
  }

  query(text, parameters = []) {
    return this.provider.query(rewriteQuestionMarkPlaceholders(text, this.dialect), parameters);
  }

  execute(text, parameters = []) {
    return this.provider.execute(rewriteQuestionMarkPlaceholders(text, this.dialect), parameters);
  }

  executeScript(text) {
    return this.provider.executeScript(text);
  }

  placeholder(index) {
    return this.provider.placeholder(index);
  }

  transaction(callback) {
    return this.provider.transaction((executor) => callback(new PortableTransactionExecutor({
      executor,
      dialect: this.dialect,
    })));
  }

  close() {
    return this.provider.close();
  }
}

export function createPortableRepositoryExecutor(provider) {
  return new PortableRepositoryExecutor({ provider });
}
