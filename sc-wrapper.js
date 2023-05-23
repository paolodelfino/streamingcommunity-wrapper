const crypto = require("crypto");
const fs = require("fs");

async function main() {
  let options_table = new Options_Table("--", {
    url: new Option("u", true, false, "streaming community url"),
    movie: new Option("m", true, false, "name of the movie to search for"),
    season: new Option("s", true, true, "number of the season to download"),
    episode: new Option("e", true, true, "number of the episode to download"),
    "max-search-results": new Option(
      undefined,
      true,
      true,
      "max number of movies in search results",
      3
    ),
    output: new Option("o", true, false, "movie output file"),
    "debug-mode": new Option("debug", false, true, "activate debug mode"),
    help: new Option("h", false, true, "print help"),
    "movie-index": new Option(
      "index",
      true,
      true,
      "index of the movie to download if multiple results found"
    ),
  });
  options_table = fill_table_by_args(process.argv, options_table);

  const app = options_table.options["app"].value;
  if (options_table.options["help"].found) {
    usage();
    process.exit(0);
  }
  alarm_on_missing_options(options_table);

  const sc_url = options_table.options["url"].value;
  const movie = options_table.options["movie"].value;
  const output_file = options_table.options["output"].value;
  const is_debug_mode = options_table.options["debug-mode"].found;

  if (!sc_url.startsWith("https://streamingcommunity.")) {
    examples();
    error("invalid url");
  }

  const max_search_results = options_table.options["max-search-results"].value;
  const movies = await search_movie(movie, max_search_results);
  if (movies.length == 0) {
    console.log("0 movies found");
    console.log(
      "if you cannot find your movie, try to increase the max search results number: --max-search-results {number}"
    );
    process.exit(0);
  }

  const chosen_movie_index_option = options_table.options["movie-index"];
  if (!chosen_movie_index_option.found && movies.length > 1) {
    for (const [index, movie] of Object.entries(movies)) {
      console.log(`${index}. ${movie.friendly_name}`);
    }
    console.log(
      `now take the index of the movie you prefer and restart the program adding: ${options_table.option_prefix}movie-index <chosen-index>`
    );
    process.exit(0);
  }

  let chosen_movie = movies[0];
  if (chosen_movie_index_option.found) {
    chosen_movie = movies[chosen_movie_index_option.value];
  }

  console.log("getting the playlist...");
  const playlist = await get_playlist(
    chosen_movie,
    options_table.options["season"].value - 1,
    options_table.options["episode"].value - 1
  );

  console.log("downloading...");
  const movie_buffer = await download_movie(playlist);

  console.log("saving file...");
  const fd = fs.openSync(output_file, "w");
  let offset = 0;
  while (offset < movie_buffer.length) {
    const buffer = movie_buffer.slice(offset, offset + 2147483647);
    fs.writeSync(fd, buffer);
    offset += buffer.length;
  }
  fs.closeSync(fd);

  console.log(`successfully downloaded file to ${output_file}`);

  /**
   *
   * @param {string[]} args
   * @param {Options_Table} table
   * @returns {Options_Table}
   */
  function fill_table_by_args(args, table) {
    //const node = args[0];
    const app = args[1];
    const args_reduced = args.splice(2);
    for (let arg_index = 0; arg_index < args_reduced.length; arg_index++) {
      const arg = args_reduced[arg_index];
      for (const [option_name, option_infos] of Object.entries(table.options)) {
        const match_option = `${table.option_prefix}${option_name}`;
        const match_option_alias = option_infos.alias
          ? `${table.option_prefix}${option_infos.alias}`
          : undefined;
        if (arg == match_option || arg == match_option_alias) {
          if (!option_infos.has_value) {
            table.options[option_name].found = true;
            break;
          }
          const option_value = args_reduced[arg_index + 1];
          if (!option_value) {
            error(`could not find value for option: ${option_name}`);
          }
          table.options[option_name].found = true;
          table.options[option_name].value = option_value;
        }
      }
    }
    table.options["app"] = new Option(undefined, true, false);
    table.options["app"].found = true;
    table.options["app"].value = app;
    table.options["app"].is_system = true;
    return table;
  }

  /**
   *
   * @param {Options_Table} table
   */
  function alarm_on_missing_options(table) {
    for (const [option_name, option_infos] of Object.entries(table.options)) {
      if (!option_infos.is_optional && !option_infos.found) {
        error(`required ${option_name} option not found`);
      }
    }
  }

  /**
   *
   * @param {string} playlist
   * @returns {string | Buffer}
   */
  async function download_movie(playlist) {
    let segments = [];
    const key = await get_key();
    const iv = get_iv(playlist);
    let require_decryption = true;
    if (!iv) {
      require_decryption = false;
    }
    let subtle;
    let is_web = false;
    try {
      if (window && window.crypto) {
        is_web = true;
      }
    } catch (err) {}
    if (is_web) {
      subtle = window.crypto.subtle;
    } else {
      subtle = crypto.webcrypto.subtle;
    }

    const aes_key = await subtle.importKey(
      "raw",
      key,
      { name: "AES-CBC" },
      false,
      ["encrypt", "decrypt"]
    );

    const callbacks = [];
    let index = -1;
    const files_url = playlist
      .split("\n")
      .filter((line) => line.includes("https://") && line.includes(".ts"))
      .map((line) => line.trim());

    const parts = [];
    const part_size = Math.ceil(files_url.length / 10);
    for (let i = 0; i < files_url.length; i += part_size) {
      parts.push(files_url.slice(i, i + part_size));
    }

    for (const part of parts) {
      for (const file_url of part) {
        const content = {
          file_url,
          index: ++index,
        };
        const callback = new Promise(async (resolve) => {
          const file_enc = await get_buffer(content.file_url);

          if (require_decryption) {
            const file_buffer = new Uint8Array(file_enc);

            const file_dec_buffer = await subtle.decrypt(
              { name: "AES-CBC", iv: iv },
              aes_key,
              file_buffer.buffer
            );

            segments[content.index] = file_dec_buffer;
          } else {
            segments[content.index] = file_enc;
          }

          resolve();
        });
        callbacks.push(callback);
      }
      await Promise.all(callbacks);
      callbacks.length = 0;
    }

    const blob = new Blob(segments);

    if (is_web) {
      const url = URL.createObjectURL(blob);
      return url;
    }

    const movie_buffer = Buffer.from(
      new Uint8Array(await blob.arrayBuffer()).buffer
    );
    return movie_buffer;
  }

  /**
   *
   * @param {Movie} movie
   * @param {Number | undefined} season_index
   * @param {Number | undefined} episode_index
   */
  async function get_playlist(movie, season_index, episode_index) {
    let movie_db_info_url = `https://scws.work/videos/`;
    let scws_id;
    if (movie.is_series) {
      if (isNaN(season_index) || isNaN(episode_index)) {
        error("missing season to download");
      }
      if (isNaN(episode_index)) {
        error("missing episode to download");
      }
      scws_id = await retrieve_ws_id(movie, season_index, episode_index);
      movie_db_info_url += scws_id;
    } else {
      movie_db_info_url += movie.scws_id;
    }

    let video_player_page_url = `${sc_url}/watch/${movie.id}`;
    if (movie.is_series) {
      video_player_page_url += `?e=${movie.seasons[season_index].episodes[episode_index].id}`;
    }
    const video_player_page_raw = await debug_get(video_player_page_url);
    const match_data_page = regex('<div id="app" data-page="(.+)"><!--', "s");
    const data_page = JSON.parse(
      decode_utf8(decode_html(video_player_page_raw.match(match_data_page)[1]))
    );
    const video_player_iframe_url = data_page.props.embedUrl;
    const video_player_iframe_page_raw = await debug_get(
      video_player_iframe_url
    );
    const match_video_player_embed_url = regex('src="(.+)".+frameborder', "s");
    const video_player_embed_url = decode_html(
      video_player_iframe_page_raw.match(match_video_player_embed_url)[1]
    );
    const video_player_embed_page_raw = await debug_get(video_player_embed_url);

    const match_master_playlist_info = regex(
      "window[.]masterPlaylistParams = (.+)const masterPlaylistUrl = new URL[(]'(.+)'[)].+for [(]",
      "s"
    );
    const master_playlist_info = video_player_embed_page_raw.match(
      match_master_playlist_info
    );
    const master_playlist_params = JSON.parse(
      validate_json(master_playlist_info[1])
    );
    const master_playlist_url = `${master_playlist_info[2]}?token=${master_playlist_params.token}&token720p=${master_playlist_params.token720p}&token360p=${master_playlist_params.token360p}&token480p=${master_playlist_params.token480p}&token1080p=${master_playlist_params.token1080p}&expires=${master_playlist_params.expires}&canCast=${master_playlist_params.canCast}&n=1`;
    const master_playlist = (await debug_get(master_playlist_url)).split("\n");
    let playlist_url;
    const match_valid_playlist_url = regex(
      "^https:.+rendition=.+token=.+&expires.+"
    );
    for (let i = 0; i < master_playlist.length; i++) {
      const line = master_playlist[i];
      if (match_valid_playlist_url.test(line)) {
        playlist_url = line;
        break;
      }
    }
    const playlist = await debug_get(playlist_url);
    let playlist_lines = playlist.split("\n");
    array_insert(playlist_lines, 2, "#EXT-X-ALLOW-CACHE:YES");
    const match_credentials_line = regex('#EXT-X-KEY.+URI="(.+)",IV.+');
    playlist_lines = playlist_lines.map((line) => {
      if (match_credentials_line.test(line)) {
        const match_key_uri = regex('URI=".+"');
        const key = retrieve_key_url();
        return line.replace(match_key_uri, `URI="${key}"`);
      }
      return line;
    });
    return playlist_lines.join("\n");
  }

  /**
   *
   * @param {any[]} array
   * @param {number} index
   * @param {any} element
   */
  function array_insert(array, index, element) {
    array.splice(index, 0, element);
  }

  /**
   *
   * @param {string} s
   * @returns {string}
   */
  function validate_json(s) {
    return s
      .split("")
      .map((c) => {
        if (c == "'") {
          return '"';
        }
        return c;
      })
      .join("");
  }

  /**
   * @returns {string}
   */
  function retrieve_key_url() {
    return "https://scws.work/storage/enc.key";
  }

  /**
   *
   * @returns {ArrayBuffer}
   */
  async function get_key() {
    const key_buffer = await get_buffer(retrieve_key_url());
    return key_buffer;
  }

  /**
   * @param {string} playlist
   * @returns {Uint8Array | undefined}
   */
  function get_iv(playlist) {
    if (!playlist.includes("IV=")) {
      return undefined;
    }
    const match_iv = regex("IV=0x(.+)");
    const iv_raw = playlist.match(match_iv)[1];
    const bytes = new Uint8Array(16);
    for (let i = 0; i < iv_raw.length; i += 2) {
      bytes[i / 2] = parseInt(iv_raw.substring(i, i + 2), 16);
    }
    return new Uint8Array(bytes);
  }

  /* async function generate_token() {
    const l = 48;
    const o = await debug_get("https://api64.ipify.org/");
    const i = "Yc8U6r8KjAKAepEA";
    let c = new Date(Date.now() + 36e5 * l).getTime();
    const s = (c = String(Math.round(c / 1e3))) + o + " " + i;

    const hash = crypto.createHash("md5").update(s).digest("hex");
    const base64 = Buffer.from(hash, "hex").toString("base64");

    const base64Url = base64
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const token = `token=${base64Url}&expires=${c}`;
    return token;
  } */

  function error(message) {
    console.log("Error: ");
    console.trace(message);
    console.log(`try ${options_table.option_prefix}help to discover more`);
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
      error(`trying to get ${url}: ${err}`);
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
    if (is_debug_mode) {
      debug(`GET request to "${url}" executed using headers: ${headers}`);
    }
    return response;
  }

  /**
   *
   * @param {string} url
   * @returns {ArrayBuffer}
   */
  async function get_buffer(url) {
    const response = await fetch(url).catch((err) => error(err.message));
    const buffer = await response.arrayBuffer();
    return buffer;
  }

  function debug(message) {
    if (is_debug_mode) {
      console.log("[DEBUG]");
      console.trace(message);
    }
  }

  function usage() {
    console.log("USAGE:");
    console.log(` node ${app} [...options]`);
    list_options(options_table);
    examples();
  }

  /**
   *
   * @param {Options_Table} options_table
   */
  function list_options(options_table /* , options_to_show_name */) {
    console.log("OPTIONS:");
    /* if (options_to_show_name && options_to_show_name.length > 0){
      
    } */
    for (const [option_name, option_infos] of Object.entries(
      options_table.options
    )) {
      if (!option_infos.is_system) {
        console.log(` ${options_table.option_prefix}${option_name}`);
        console.log(`     alias: ${option_infos.alias}`);
        console.log(`     has value: ${option_infos.has_value}`);
        console.log(`     is optional: ${option_infos.is_optional}`);
        console.log(`     description: ${option_infos.description}`);
      }
    }
  }

  function examples() {
    console.log("EXAMPLES:");
    console.log(
      ` node ${app} --u "https://streamingcommunity.codes" --m "rick and morty" --s "1" --e "3" --o "movie.mp4"`
    );
    console.log(
      ` node ${app} --u "https://streamingcommunity.codes" --m "Enola Holmes 2" --o "movie.mp4"`
    );
  }

  /**
   *
   * @param {object} record
   * @param {boolean} [findRelated=true]
   * @returns {Movie}
   */
  async function retrieve_movie_info(record) {
    const slug = record.slug;
    const id = record.id;
    const images = record.images.map((image_info) => {
      return new MImage(
        image_info.type,
        `${sc_url.replace("https://", "https://cdn.")}/images/${
          image_info.filename
        }`
      );
    });

    const movie_page_raw = await debug_get(`${sc_url}/titles/${id}-${slug}`);
    const match_data_page = regex('<div id="app" data-page="(.+)"><!--', "s");
    const data_page = JSON.parse(
      decode_utf8(decode_html(movie_page_raw.match(match_data_page)[1]))
    );

    const movie_info = data_page.props.title;
    const score = movie_info.score;
    const release_date = movie_info.release_date;
    const friendly_name = movie_info.name;
    const plot = movie_info.plot;
    const scws_id = movie_info.scws_id;
    const trailers = movie_info.trailers;
    let trailer_url;
    if (trailers.length > 0) {
      trailer_url = `https://youtube.com/watch?v=${trailers[0].youtube_id}`;
    }

    const seasons = [];
    const seasons_info = movie_info.seasons;
    for (const season of seasons_info) {
      const season_number = season.number;
      const season_page_raw = await debug_get(
        `${sc_url}/titles/${id}-${slug}/stagione-${season_number}`
      );
      const season_info = JSON.parse(
        decode_utf8(decode_html(season_page_raw.match(match_data_page)[1]))
      ).props.loadedSeason;
      const episodes = [];
      for (const episode of season_info.episodes) {
        const episode_id = episode.id;
        const episode_name = episode.name;
        const episode_number = episode.number;
        const episode_plot = episode.plot;
        episodes.push(
          new Episode(episode_id, episode_number, episode_name, episode_plot)
        );
      }
      seasons.push(new Season(season_number, episodes));
    }

    return new Movie(
      seasons,
      seasons.length > 0,
      slug,
      id,
      images,
      plot,
      friendly_name,
      scws_id,
      trailer_url,
      score,
      release_date
    );
  }

  /**
   * @param {string} name
   * @param {number} max_results
   * @return {Movie[]}
   */
  async function search_movie(name, max_results) {
    const search_page = await debug_get(`${sc_url}/search?q=${name}`);
    const match_data_page = regex('<div id="app".+data-page="(.+)"><!--', "s");
    const data_page = JSON.parse(
      decode_utf8(decode_html(search_page.match(match_data_page)[1]))
    );
    const records = data_page.props.titles;

    const movies_found = [];
    let count = 0;
    for (const record of records) {
      if (count++ >= max_results) {
        break;
      }
      const movie = await retrieve_movie_info(record);
      movies_found.push(movie);
    }

    return movies_found;
  }

  /**
   *
   * @param {Movie} movie
   * @param {number} season_index
   * @param {number} episode_index
   * @returns {number}
   */
  async function retrieve_ws_id(movie, season_index, episode_index) {
    let video_player_page_url = `${sc_url}/watch/${movie.id}`;
    if (movie.is_series) {
      if (isNaN(season_index) || isNaN(episode_index)) {
        error("missing season to download");
      }
      if (isNaN(episode_index)) {
        error("missing episode to download");
      }
      video_player_page_url += `?e=${movie.seasons[season_index].episodes[episode_index].id}`;
    }
    const video_player_page_raw = decode_utf8(
      decode_html(await debug_get(video_player_page_url))
    );
    const match_video_player_info = regex(
      '<div id="app" data-page="(.+)"><!--',
      "s"
    );
    const video_player_info = JSON.parse(
      video_player_page_raw.match(match_video_player_info)[1]
    ).props;
    const scws_id = video_player_info.episode.scws_id;
    return scws_id;
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
      "&amp;": "&",
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
  /**
   * @type {string}
   */
  trailer_url;
  /**
   * @type {string}
   */
  score;
  /**
   * @type {string}
   */
  release_date;

  constructor(
    seasons,
    is_series,
    slug,
    id,
    images,
    plot,
    friendly_name,
    scws_id,
    trailer_url,
    score,
    release_date
  ) {
    this.seasons = seasons;
    this.is_series = is_series;
    this.slug = slug;
    this.id = id;
    this.images = images;
    this.plot = plot;
    this.friendly_name = friendly_name;
    this.scws_id = scws_id;
    this.trailer_url = trailer_url;
    this.score = score;
    this.release_date = release_date;
  }
}

class Season {
  /**
   * @type {number}
   */
  number;
  /**
   * @type {Episode[]}
   */
  episodes = [];

  constructor(number, episodes) {
    this.number = number;
    this.episodes = episodes;
  }
}

class Episode {
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

  constructor(id, number, name, plot) {
    this.id = id;
    this.number = number;
    this.name = name;
    this.plot = plot;
  }
}

class MImage {
  /**
   * @type {string}
   */
  type;
  /**
   * @type {string}
   */
  url;

  constructor(type, url) {
    this.type = type;
    this.url = url;
  }
}

class Options_Table {
  /**
   * @type {string}
   */
  option_prefix;
  /**
   * @type {{[option_name: string]: Option}}
   */
  options;

  /**
   * @param {string} option_prefix
   * @param {{[option_name: string]: Option}} options
   */
  constructor(option_prefix, options) {
    this.option_prefix = option_prefix;
    this.options = options;
  }
}

class Option {
  /**
   * @type {string}
   */
  alias;
  /**
   * @type {boolean}
   */
  has_value;
  /**
   * @type {string}
   */
  value;
  /**
   * @type {boolean}
   */
  found;
  /**
   * @type {boolean}
   */
  is_optional;
  /**
   * @type {boolean}
   */
  is_system;
  /**
   * @type {string}
   */
  description;

  /**
   *
   * @param {string} alias
   * @param {boolean} has_value
   * @param {boolean} is_optional
   * @param {string} description
   * @param {string} default_value
   */
  constructor(alias, has_value, is_optional, description, default_value) {
    this.alias = alias;
    this.has_value = has_value;
    this.is_optional = is_optional;
    this.description = description;
    this.value = default_value;
  }
}

main();
