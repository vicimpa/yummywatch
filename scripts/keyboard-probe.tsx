import { AppLink } from '~/ui/AppLink';
// Real keyboard handlers and CSS, with deterministic content and no network dependencies.
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { useHash } from '~/lib/hooks';
import { InterfaceEffects } from '~/components/InterfaceEffects';
import { MediaNavigation } from '~/components/MediaNavigation';
import { GalleryShelf } from '~/components/GalleryShelf';
import { Sidebar } from '~/ui';
import { navigateGallery } from '~/lib/gallery-navigation';

function Probe() {
  const path = useHash(),
    [open, setOpen] = useState(false);

  return (
    <div class="media-app">
      <InterfaceEffects
        path={path}
        onBack={() => {
          location.hash = '/';
        }}
      />
      <MediaNavigation path={path} selected={path} />
      <div class="workspace media-workspace">
        <main id="main" class="media-scroll" tabIndex={-1}>
          <div class="media-scroll-content">
            {['/', '/catalog', '/search', '/settings', '/account'].map(route => (
              <section
                key={route}
                data-route={route}
                hidden={route !== path}
                onKeyDown={navigateGallery}
              >
                <header class="gallery-heading">
                  <h1>Служебный заголовок</h1>
                  <button class="button secondary" onClick={() => setOpen(true)}>
                    Открыть серии
                  </button>
                </header>
                <div class="gallery-feature-copy">
                  <h2>Название информационного произведения</h2>
                  <p class="gallery-feature-description">
                    Описание, которое можно выделить и скопировать.
                  </p>
                </div>
                <div class="comment-text">
                  <span>Комментарий пользователя, доступный для выделения.</span>
                  <button class="inline-spoiler">Спойлер · показать</button>
                </div>
                {[0, 1, 2].map(row => (
                  <GalleryShelf key={row} title={`Ряд ${row}`} href="#/catalog" count={12}>
                    {Array.from({ length: 12 }, (_, index) => (
                      <article key={index} class="anime-card" data-gallery-item>
                        <div class="card-image" style={{ height: 230, background: '#3b3b42' }}>
                          <a href="#unused" tabIndex={-1} aria-hidden="true">
                            Постер
                          </a>
                        </div>
                        <div class="card-caption">
                          <h3>
                            <AppLink
                              class="card-title"
                              data-gallery-link
                              href={`#/anime/${row * 12 + index}`}
                              data-index={index}
                            >
                              {route} · Аниме {row * 12 + index}
                            </AppLink>
                          </h3>
                          <p>2026 · Сериал</p>
                        </div>
                      </article>
                    ))}
                  </GalleryShelf>
                ))}
              </section>
            ))}
          </div>
        </main>
      </div>
      <Sidebar open={open} title="Серии" close={() => setOpen(false)}>
        {Array.from({ length: 35 }, (_, index) => (
          <button
            class="button secondary"
            style={{ display: 'block', width: '100%', marginBottom: 12 }}
            key={index}
          >
            Серия {index + 1}
          </button>
        ))}
      </Sidebar>
    </div>
  );
}

render(<Probe />, document.getElementById('app')!);
