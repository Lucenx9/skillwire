import type {
  ExternalCatalogStore,
  SourceRegistration,
} from "../ports/external-catalog-store.js";
import type {
  GitHubSourceProvider,
  OperationContext,
} from "../ports/github-source-provider.js";
import type { GitHubRepositoryCoordinate } from "../../domain/external-catalog/types.js";

export class SourceRegistrationService {
  constructor(
    private readonly provider: GitHubSourceProvider,
    private readonly store: ExternalCatalogStore,
  ) {}

  async add(
    coordinate: GitHubRepositoryCoordinate,
    registeredBy: string,
    context?: OperationContext,
  ): Promise<SourceRegistration> {
    const repository = await this.provider.resolvePublicRepository(
      coordinate,
      context,
    );
    return this.store.registerSource(repository, registeredBy, context);
  }

  list(context?: OperationContext): Promise<readonly SourceRegistration[]> {
    return this.store.listSources(context);
  }
}
