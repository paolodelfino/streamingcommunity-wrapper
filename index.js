async function main() {
  let argc = 0;
  const app = process.argv[++argc];
  const sc_url = process.argv[++argc];
  const movie = process.argv[++argc];
  const debug_mode = process.argv[++argc] == "-debug";

  if (!sc_url || !movie) {
    usage();
    error("parameter is missing");
  }

  if (!sc_url.startsWith("https://")) {
    examples();
    error("invalid url");
  }

  const movies = await search_movie(movie);
  // only an assumption
  const chosen_movie = movies[0];
  await download_movie(chosen_movie);

  /**
   *
   * @param {Movie} movie
   */
  async function download_movie(movie) {
    debug(movie);
    //await debug_get(`https://scws.work/videos/${movie.scsw_id}`);
  }

  function error(message) {
    console.log("Error: ");
    console.log(message);
    process.exit(1);
  }

  /**
   * @param {Headers | undefined} headers
   * @returns {string}
   */
  async function handled_get(url, headers) {
    const response = await fetch(url, {
      headers,
    }).catch((err) => {
      error(err);
      process.exit(1);
    });
    return response.text();
  }

  /**
   *
   * @param {string} url
   * @param {Headers} headers
   * @returns {string}
   */
  async function debug_get(url, headers) {
    let response = await handled_get(url, headers);
    if (debug_mode) {
      debug(`GET request to "${url}" executed using headers: ${headers}`);
    }
    return response;
  }

  function debug(message) {
    if (debug_mode) {
      console.log("[DEBUG]");
      console.trace(message);
    }
  }

  function usage() {
    console.log("USAGE:");
    console.log(` node ${app} <streamingcommunity url> <movie name>`);
    examples();
  }

  function examples() {
    console.log("EXAMPLES:");
    console.log(
      ' node index.js "https://streamingcommunity.army" "Enola Holmes 2"'
    );
    console.log(
      ' node index.js "https://streamingcommunity.army" "Rick and Morty"'
    );
  }

  /**
   * @param {string} name
   * @return {Movie[]}
   */
  async function search_movie(name) {
    const search_page = await debug_get(`${sc_url}/search?q=${name}`);
    const match_records = regex(
      '<the-search-page.+records-json="(.+)".+route',
      "s"
    );
    const encoded_records = search_page.match(match_records)[1];
    const decoded_records = decode_html(encoded_records);
    const records = JSON.parse(decoded_records);

    const movies_found = [];
    for (const key in records) {
      const record = records[key];
      const slug = record.slug;
      const id = record.id;
      const images = record.images.map((image_infos) => {
        return new MImage(image_infos.type, image_infos.sc_url);
      });

      const movie_page = await debug_get(`${sc_url}/titles/${id}-${slug}`);
      const decoded_movie_page = decode_utf8(decode_html(movie_page));
      const movie_seasons = [];
      const match_infos = regex(
        '<season-select.+seasons="(.+)".+title_id="[0-9]+".+title-json="(.+)">.+season-select>',
        "s"
      );
      const movie_infos = decoded_movie_page.match(match_infos);
      if (movie_infos) {
        const seasons = JSON.parse(decode_utf8(movie_infos[1]));

        for (const key in seasons) {
          const season = seasons[key];
          const season_number = season.number;
          const episodes = [];
          for (const key in season.episodes) {
            const episode = season.episodes[key];
            const episode_id = episode.id;
            const episode_name = episode.name;
            const episode_number = episode.number;
            const episode_plot = episode.plot;
            episodes.push(
              new Episode(
                episode_id,
                episode_number,
                episode_name,
                episode_plot
              )
            );
          }
          movie_seasons.push(new Season(season_number, episodes));
        }
      }

      const video_player_page = await debug_get(`${sc_url}/watch/${id}`);
      const match_video_player = regex(
        '<video-player.+response="(.+)".+video-player>',
        "s"
      );
      const video_player_infos = JSON.parse(
        decode_utf8(decode_html(video_player_page.match(match_video_player)[1]))
      );
      const friendly_name = video_player_infos.title.name;
      const plot = video_player_infos.title.plot;
      const scws_id = video_player_infos.scws_id;

      movies_found.push(
        new Movie(
          movie_seasons,
          movie_seasons.length > 0,
          slug,
          id,
          images,
          plot,
          friendly_name,
          scws_id
        )
      );
    }

    return movies_found;
  }

  /**
   *
   * @param {string} pattern
   * @param {string} flags
   * @returns {RegExp}
   */
  function regex(pattern, flags) {
    return new RegExp(pattern, flags);
  }

  /**
   *
   * @param {string} utf8_encoded
   * @returns {string}
   */
  function decode_utf8(utf8_encoded) {
    const table = {
      "\u00e8": "è",
      "\u0027": "'",
    };
    const decoded = decode_with_table(utf8_encoded, table);
    return decoded;
  }

  /**
   *
   * @param {string} html_encoded
   */
  function decode_html(html_encoded) {
    const table = {
      "&quot;": '"',
      "&#039;": "'",
    };

    const decoded = decode_with_table(html_encoded, table);
    return decoded;
  }

  /**
   *
   * @param {string} s
   * @param {object} key_value_table
   */
  function decode_with_table(s, key_value_table) {
    const decoded = replace_with_table(s, key_value_table);
    return decoded;
  }

  /**
   *
   * @param {string} s
   * @param {object} key_value_table
   * @returns
   */
  function replace_with_table(s, key_value_table) {
    let s_with_replace = s;
    for (const key in key_value_table) {
      const value = key_value_table[key];
      s_with_replace = s_with_replace.replace(regex(key, "g"), value);
    }
    return s_with_replace;
  }
}

class Movie {
  constructor(
    seasons,
    is_series,
    slug,
    id,
    images,
    plot,
    friendly_name,
    scws_id
  ) {
    this.seasons = seasons;
    this.is_series = is_series;
    this.slug = slug;
    this.id = id;
    this.images = images;
    this.plot = plot;
    this.friendly_name = friendly_name;
    this.scws_id = scws_id;
  }
  /**
   * @type {Season[]}
   */
  seasons = [];
  /**
   * @type {boolean}
   */
  is_series;
  /**
   * @type {string}
   */
  slug;
  /**
   * @type {string}
   */
  id;
  /**
   * @type {MImage[]}
   */
  images = [];
  /**
   * @type {string}
   */
  plot;
  /**
   * @type {string}
   */
  friendly_name;
  /**
   * @type {string}
   */
  scws_id;
}

class Season {
  constructor(number, episodes) {
    this.number = number;
    this.episodes = episodes;
  }
  /**
   * @type {number}
   */
  number;
  /**
   * @type {Episode[]}
   */
  episodes = [];
}

class Episode {
  constructor(id, number, name, plot) {
    this.id = id;
    this.number = number;
    this.name = name;
    this.plot = plot;
  }
  /**
   * @type {number}
   */
  id;
  /**
   * @type {number}
   */
  number;
  /**
   * @type {string}
   */
  name;
  /**
   * @type {string}
   */
  plot;
}

class MImage {
  constructor(type, url) {
    this.type = type;
    this.url = url;
  }
  /**
   * @type {string}
   */
  type;
  /**
   * @type {string}
   */
  url;
}

main();
