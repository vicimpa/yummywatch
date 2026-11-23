import type { ComponentChildren, FunctionalComponent as FC } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { isTvMode } from '~/lib/tv-mode';
import { Button, ButtonLink, Icon } from '~/ui';

export type TGalleryShelfProps = {
  title: string;
  href: string;
  children: ComponentChildren;
  count: number;
  subtitle?: string;
  className?: string;
};

export const GalleryShelf: FC<TGalleryShelfProps> = ({
  title,
  href,
  children,
  count,
  subtitle,
  className,
}) => {
  const rail = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const update = useCallback(() => {
    const element = rail.current;

    if (element) {
      const start = element.scrollLeft < 2,
        end = element.scrollLeft + element.clientWidth >= element.scrollWidth - 2;

      setEdges(previous =>
        previous.start === start && previous.end === end ? previous : { start, end }
      );
    }
  }, []);

  useEffect(() => {
    update();

    let frame = 0;
    // Rendering from the observer itself can resize the rail during delivery.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(update);
          });

    if (rail.current) observer?.observe(rail.current);

    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [count]);

  const move = useCallback(
    (direction: number) =>
      rail.current?.scrollBy({
        left: direction * rail.current.clientWidth * 0.8,
        behavior:
          isTvMode() || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
      }),
    []
  );

  const previousPage = useCallback(() => move(-1), [move]);

  const nextPage = useCallback(() => move(1), [move]);

  return (
    <section
      class={`section gallery-shelf${className ? ` ${className}` : ''}`}
      aria-label={title}
      data-tv-focus-group
    >
      <div class="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div class="gallery-shelf-actions">
          <ButtonLink href={href} variant="text">
            Все
            <Icon name="arrow" size={16} />
          </ButtonLink>
          <Button
            aria-label={`${title}: назад`}
            disabled={edges.start}
            onClick={previousPage}
            variant="icon"
          >
            <Icon name="back" size={18} />
          </Button>
          <Button
            aria-label={`${title}: вперёд`}
            disabled={edges.end}
            onClick={nextPage}
            variant="icon"
          >
            <Icon name="arrow" size={18} />
          </Button>
        </div>
      </div>
      <div ref={rail} class="poster-rail gallery-rail" data-gallery-row onScroll={update}>
        {children}
      </div>
    </section>
  );
};

export type TGalleryToolbarProps = {
  title: string;
  subtitle?: string;
  onFilters?: () => void;
  count?: number;
};

export const GalleryToolbar: FC<TGalleryToolbarProps> = ({
  title,
  subtitle,
  onFilters,
  count = 0,
}) => (
  <header class="gallery-heading">
    <div>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
    <nav class="gallery-actions" aria-label="Действия каталога">
      {onFilters && (
        <button
          class={`button secondary ${count ? 'has-filters' : ''}`}
          aria-haspopup="dialog"
          onClick={onFilters}
        >
          <Icon name="filter" size={20} />
          <span>Фильтры</span>
          {count > 0 && <small>{count}</small>}
        </button>
      )}
      <ButtonLink
        href="#/profile?tab=collection"
        aria-label="Коллекция профиля"
        class="gallery-collection-action"
      >
        <Icon name="bookmark" size={20} />
        <span>Коллекция</span>
      </ButtonLink>
    </nav>
  </header>
);
