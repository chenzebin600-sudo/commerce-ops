export class TransactionManager {
  constructor({ begin, commit, rollback }) {
    if (![begin, commit, rollback].every((operation) => typeof operation === "function")) {
      throw new TypeError("Transaction manager operations are required");
    }
    this.begin = begin;
    this.commit = commit;
    this.rollback = rollback;
  }

  run(callback) {
    if (typeof callback !== "function") throw new TypeError("Transaction callback is required");
    this.begin();
    try {
      const result = callback();
      if (result && typeof result.then === "function") {
        throw new TypeError("Synchronous transaction manager does not accept async callbacks");
      }
      this.commit();
      return result;
    } catch (error) {
      try {
        this.rollback();
      } catch {
        // Preserve the original business or database error.
      }
      throw error;
    }
  }
}
