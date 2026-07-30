import { FoundationAccountRegistry } from "./foundation-account-registry.mjs";
import { FoundationMasterDataService } from "./foundation-master-data-service.mjs";
import { FoundationProjectionService } from "./foundation-projection-service.mjs";
import { FoundationTaskService } from "./foundation-task-service.mjs";
import { FOUNDATION_SCHEMA_VERSION } from "./foundation-contracts.mjs";

export class FoundationService {
  constructor({ repository, now = () => new Date() }) {
    this.repository = repository;
    this.now = now;
    this.accounts = new FoundationAccountRegistry({ repository, now });
    this.masterData = new FoundationMasterDataService({ repository, now });
    this.tasks = new FoundationTaskService({ repository, now });
    this.projections = new FoundationProjectionService({
      repository,
      taskService: this.tasks,
      now,
    });
  }

  async status() {
    const ready = await this.repository.isReady();
    return {
      schemaVersion: FOUNDATION_SCHEMA_VERSION,
      ready,
      activationStatus: ready ? "available" : "migration_required",
      taskSummary: ready ? await this.repository.domainSummary() : [],
    };
  }

  async synchronize({ listingJobs = [] } = {}) {
    if (!await this.repository.isReady()) {
      throw Object.assign(new Error("Foundation V1 candidate migration is not applied."), {
        code: "FOUNDATION_MIGRATION_REQUIRED",
      });
    }
    const accounts = await this.accounts.synchronizeMabangAccounts();
    const masterData = await this.masterData.synchronize();
    const projections = await this.projections.projectAll({ listingJobs });
    return {
      schemaVersion: FOUNDATION_SCHEMA_VERSION,
      accounts,
      masterData,
      projections,
    };
  }
}

