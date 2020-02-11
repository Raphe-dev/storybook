import deprecate from 'util-deprecate';
import dedent from 'ts-dedent';
import { sanitize, parseKind } from '@storybook/csf';
import merge from './merge';
import { InceptionRef } from '../modules/refs';

export type StoryId = string;

export interface Root {
  id: StoryId;
  depth: 0;
  name: string;
  children: StoryId[];
  isComponent: false;
  isRoot: true;
  isLeaf: false;
  // MDX stories are "Group" type
  parameters?: any;
}

export interface Group {
  id: StoryId;
  depth: number;
  name: string;
  children: StoryId[];
  parent?: StoryId;
  isComponent: boolean;
  isRoot: false;
  isLeaf: false;
  // MDX stories are "Group" type
  parameters?: any;
}

export interface Story {
  id: StoryId;
  depth: number;
  parent: StoryId;
  name: string;
  kind: string;
  knownAs?: StoryId;
  ref?: InceptionRef;
  children?: StoryId[];
  isComponent: false;
  isRoot: false;
  isLeaf: true;
  parameters?: {
    filename: string;
    options: {
      hierarchyRootSeparator?: RegExp;
      hierarchySeparator?: RegExp;
      showRoots?: boolean;
    } & Record<string, any>;
  } & Record<string, any>;
}

export interface StoryInput {
  id: StoryId;
  name: string;
  knownAs?: StoryId;
  ref?: InceptionRef;
  kind: string;
  children: string[];
  parameters: {
    filename: string;
    options: {
      hierarchyRootSeparator: RegExp;
      hierarchySeparator: RegExp;
      showRoots?: boolean;
      [key: string]: any;
    };
    [parameterName: string]: any;
  };
  isLeaf: boolean;
}

// export type Story = StoryInput & Group;

export interface StoriesHash {
  [id: string]: Root | Group | Story;
}

export type StoriesList = (Group | Story)[];

export type GroupsList = Group[];

export interface StoriesRaw {
  [id: string]: StoryInput;
}

const warnUsingHierarchySeparatorsAndShowRoots = deprecate(
  () => {},
  dedent`
    You cannot use both the hierarchySeparator/hierarchyRootSeparator and showRoots options.
  `
);

const warnRemovingHierarchySeparators = deprecate(
  () => {},
  dedent`
    hierarchySeparator and hierarchyRootSeparator are deprecated and will be removed in Storybook 6.0.
    Read more about it in the migration guide: https://github.com/storybookjs/storybook/blob/master/MIGRATION.md
  `
);

const warnChangingDefaultHierarchySeparators = deprecate(
  () => {},
  dedent`
    The default hierarchy separators are changing in Storybook 6.0.
    '|' and '.' will no longer create a hierarchy, but codemods are available.
    Read more about it in the migration guide: https://github.com/storybookjs/storybook/blob/master/MIGRATION.md
  `
);

const toKey = (input: string) =>
  input.replace(/[^a-z0-9]+([a-z0-9])/gi, (...params) => params[1].toUpperCase());

const toGroup = (name: string) => ({
  name,
  id: toKey(name),
});

export const transformStoriesRawToStoriesHash = (
  input: StoriesRaw,
  base: StoriesHash,
  options: Record<string, any>
): StoriesHash => {
  const anyKindMatchesOldHierarchySeparators = Object.values(input).some(({ kind }) =>
    kind.match(/\.|\|/)
  );

  const storiesHashOutOfOrder = Object.values(input).reduce((acc, item) => {
    const { kind, parameters } = item;
    const {
      hierarchyRootSeparator: rootSeparator = undefined,
      hierarchySeparator: groupSeparator = undefined,
      showRoots = undefined,
    } = (parameters && parameters.options) || {};

    const usingShowRoots = typeof showRoots !== 'undefined';

    // Kind splitting behavior as per https://github.com/storybookjs/storybook/issues/8793
    let root = '';
    let groups: string[];
    // 1. If the user has passed separators, use the old behavior but warn them
    if (typeof rootSeparator !== 'undefined' || typeof groupSeparator !== 'undefined') {
      warnRemovingHierarchySeparators();
      if (usingShowRoots) warnUsingHierarchySeparatorsAndShowRoots();
      ({ root, groups } = parseKind(kind, {
        rootSeparator: rootSeparator || '|',
        groupSeparator: groupSeparator || /\/|\./,
      }));

      // 2. If the user hasn't passed separators, but is using | or . in kinds, use the old behaviour but warn
    } else if (anyKindMatchesOldHierarchySeparators && !usingShowRoots) {
      warnChangingDefaultHierarchySeparators();
      ({ root, groups } = parseKind(kind, { rootSeparator: '|', groupSeparator: /\/|\./ }));

      // 3. If the user passes showRoots, or doesn't match above, do a simpler splitting.
    } else {
      const parts: string[] = kind.split('/');
      if (showRoots && parts.length > 1) {
        [root, ...groups] = parts;
      } else {
        groups = parts;
      }
    }

    const rootAndGroups = []
      .concat(root || [])
      .concat(groups)
      .map(toGroup)
      // Map a bunch of extra fields onto the groups, collecting the path as we go (thus the reduce)
      .reduce((soFar, group, index, original) => {
        const { name } = group;
        const parent = index > 0 && soFar[index - 1].id;
        const id = sanitize(parent ? `${parent}-${name}` : name);
        if (parent === id) {
          throw new Error(
            dedent`
              Invalid part '${name}', leading to id === parentId ('${id}'), inside kind '${kind}'

              Did you create a path that uses the separator char accidentally, such as 'Vue <docs/>' where '/' is a separator char? See https://github.com/storybookjs/storybook/issues/6128
            `
          );
        }

        const result: Group = {
          ...group,
          id,
          parent,
          depth: index,
          children: [],
          isComponent: false,
          isLeaf: false,
          isRoot: !!root && index === 0,
          parameters,
        };
        return soFar.concat([result]);
      }, [] as GroupsList);

    const paths = [...rootAndGroups.map(g => g.id), item.id];

    // Ok, now let's add everything to the store
    rootAndGroups.forEach((group, index) => {
      const child = paths[index + 1];
      const { id } = group;
      acc[id] = merge(acc[id] || {}, {
        ...group,
        ...(child && { children: [child] }),
      });
    });

    const story = { ...item, parent: rootAndGroups[rootAndGroups.length - 1].id, isLeaf: true };
    acc[item.id] = story as Story;

    return acc;
  }, {} as StoriesHash);

  function addItem(acc: StoriesHash, item: Story | Group) {
    if (!acc[item.id]) {
      // If we were already inserted as part of a group, that's great.
      acc[item.id] = item;
      const { children } = item;
      if (children) {
        const childNodes = children.map(id => storiesHashOutOfOrder[id]);
        acc[item.id].isComponent = childNodes.every(childNode => childNode.isLeaf);
        childNodes.forEach(childNode => addItem(acc, childNode));
      }
    }
    return acc;
  }

  return Object.values(storiesHashOutOfOrder).reduce(addItem, base);
};
