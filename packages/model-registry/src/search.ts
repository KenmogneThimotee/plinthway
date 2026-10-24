import type { CatalogSnapshot, ModelMetadata, ProviderMetadata } from './normalizer.js';

export interface CatalogProviderGroup {
  readonly provider: ProviderMetadata;
  readonly models: readonly ModelMetadata[];
  readonly rank: number;
}

export interface CatalogSearchResult {
  readonly groups: readonly CatalogProviderGroup[];
  readonly modelRefs: readonly string[];
  readonly providerCount: number;
  readonly modelCount: number;
}

export interface CatalogSearchIndex {
  search(query: string): CatalogSearchResult;
}

interface SearchDocument {
  readonly provider: ProviderMetadata;
  readonly model: ModelMetadata;
  readonly fields: readonly string[];
}

interface RankedDocument extends SearchDocument {
  readonly matchClass: number;
  readonly fieldPriority: number;
}

const normalize = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase('en-US').trim();

function fieldMatch(field: string, query: string): number | undefined {
  if (field === query) return 0;
  if (field.startsWith(query)) return 1;
  if (field.split(/[^\p{L}\p{N}]+/u).includes(query)) return 2;
  if (field.includes(query)) return 3;
  return undefined;
}

function rank(document: SearchDocument, query: string): RankedDocument | undefined {
  if (query.length === 0) return { ...document, matchClass: 0, fieldPriority: 0 };
  const terms = query.split(/\s+/u);
  let worstClass = 0;
  let totalPriority = 0;

  for (const term of terms) {
    let best: readonly [number, number] | undefined;
    document.fields.forEach((field, fieldPriority) => {
      const matchClass = fieldMatch(field, term);
      if (
        matchClass !== undefined &&
        (best === undefined ||
          matchClass < best[0] ||
          (matchClass === best[0] && fieldPriority < best[1]))
      ) {
        best = [matchClass, fieldPriority];
      }
    });
    if (best === undefined) return undefined;
    worstClass = Math.max(worstClass, best[0]);
    totalPriority += best[1];
  }

  return { ...document, matchClass: worstClass, fieldPriority: totalPriority };
}

function compareRanked(left: RankedDocument, right: RankedDocument): number {
  return (
    left.matchClass - right.matchClass ||
    left.fieldPriority - right.fieldPriority ||
    left.provider.name.localeCompare(right.provider.name) ||
    left.model.name.localeCompare(right.model.name) ||
    left.model.id.localeCompare(right.model.id)
  );
}

function emptyResult(): CatalogSearchResult {
  return Object.freeze({
    groups: Object.freeze([]),
    modelRefs: Object.freeze([]),
    providerCount: 0,
    modelCount: 0,
  });
}

export function createCatalogSearchIndex(snapshot: CatalogSnapshot): CatalogSearchIndex {
  const documents = Object.freeze(
    [...snapshot.models.values()].flatMap((model) => {
      const provider = snapshot.providers.get(model.providerId);
      if (provider === undefined) return [];
      return [
        Object.freeze({
          provider,
          model,
          fields: Object.freeze(
            [model.id, model.modelId, model.name, provider.id, provider.name].map(normalize),
          ),
        }),
      ];
    }),
  );

  return Object.freeze({
    search(rawQuery: string): CatalogSearchResult {
      const query = normalize(rawQuery);
      const ranked = documents
        .map((document) => rank(document, query))
        .filter((document): document is RankedDocument => document !== undefined)
        .sort(compareRanked);
      if (ranked.length === 0) return emptyResult();

      const byProvider = new Map<
        string,
        { provider: ProviderMetadata; documents: RankedDocument[] }
      >();
      for (const document of ranked) {
        const existing = byProvider.get(document.provider.id);
        if (existing === undefined) {
          byProvider.set(document.provider.id, {
            provider: document.provider,
            documents: [document],
          });
        } else {
          existing.documents.push(document);
        }
      }

      const groups = [...byProvider.values()]
        .map(({ provider, documents: providerDocuments }) =>
          Object.freeze({
            provider,
            models: Object.freeze(providerDocuments.map(({ model }) => model)),
            rank: providerDocuments[0]?.matchClass ?? 0,
            first: providerDocuments[0],
          }),
        )
        .sort((left, right) => {
          if (query.length === 0) {
            return (
              left.provider.name.localeCompare(right.provider.name) ||
              left.provider.id.localeCompare(right.provider.id)
            );
          }
          if (left.first === undefined) return 1;
          if (right.first === undefined) return -1;
          return compareRanked(left.first, right.first);
        })
        .map(({ provider, models, rank: groupRank }) =>
          Object.freeze({ provider, models, rank: groupRank }),
        );
      const modelRefs = Object.freeze(groups.flatMap((group) => group.models.map(({ id }) => id)));
      return Object.freeze({
        groups: Object.freeze(groups),
        modelRefs,
        providerCount: groups.length,
        modelCount: modelRefs.length,
      });
    },
  });
}
