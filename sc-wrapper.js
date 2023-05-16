import crypto from "crypto";
import fs from "fs";

async function main() {
  let options_table = new Options_Table("--", {
    url: new Option("u", true, false, "streaming community url"),
    movie: new Option("m", true, false, "name of the movie to search for"),
    season: new Option("s", true, true, "number of the season to download"),
    episode: new Option("e", true, true, "number of the episode to download"),
    output: new Option("o", true, false, "playlist output file"),
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

  const movies = await search_movie(movie);
  if (movies.length == 0) {
    console.log("0 movies found");
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
  const playlist = await get_playlist(
    chosen_movie,
    options_table.options["season"].value - 1,
    options_table.options["episode"].value - 1
  );
  if (output_file) {
    fs.writeFileSync(output_file, playlist);
    console.log(`playlist saved successfully to ${output_file}`);
  }
  /* const blob_url = await download_movie(playlist);
  debug(blob_url); */

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
   * @returns {string}
   */
  async function download_movie(playlist) {
    const match_ts_file = regex("^https://.+[0-9]{4}-[0-9]{4}[.]ts");
    const unordered_blobs = [];
    const callbacks = [];
    let index = -1;
    for (const line of playlist.split("\n")) {
      if (match_ts_file.test(line)) {
        callbacks.push(
          new Promise((resolve) => {
            fetch(line)
              .then((response) => response.blob())
              .then((blob) => {
                unordered_blobs.push({
                  blob: blob,
                  index: ++index,
                  url: line,
                });
                resolve();
              });
          })
        );
      }
    }
    await Promise.all(callbacks);
    debug(unordered_blobs);
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

    const movie_db_infos_raw = await debug_get(movie_db_info_url); // ERROR HERE
    const movie_db_info = JSON.parse(movie_db_infos_raw);
    const folder_id = movie_db_info.folder_id;
    const quality = `${movie_db_info.quality}p`;
    const storage_number = movie_db_info.storage.number;
    let proxy_index = movie_db_info.proxy_index;
    const cdn = movie_db_info.cdn;
    const cdn_type_number = `${cdn.type}${cdn.number}`;
    const proxies = cdn.proxies;
    const max_number = proxies[proxies.length - 1].number;

    const token = await generate_token();
    const playlist = await debug_get(
      `https://scws.work/master/${
        scws_id ? scws_id : movie.scws_id
      }?type=video&rendition=${quality}&${token}`
    );
    let playlist_lines = playlist.split("\n");
    const match_ts_file = regex("^[0-9]{4}-[0-9]{4}[.]ts");
    const match_credentials_line = regex('#EXT-X-KEY.+URI="(.+)",IV.+');
    for (const line_key in playlist_lines) {
      if (match_ts_file.test(playlist_lines[line_key])) {
        ++proxy_index;
        if (proxy_index > max_number) {
          proxy_index = 1;
        }
        const proxy_index_template = `${proxy_index}`.padStart(2, "0");
        const ts_file_url = `https://sc-${cdn_type_number}-${proxy_index_template}.scws-content.net/hls/${storage_number}/${folder_id}/video/${quality}/${playlist_lines[line_key]}`;
        playlist_lines[line_key] = ts_file_url;
      }

      const credentials_line = playlist_lines[line_key].match(
        match_credentials_line
      );
      if (credentials_line) {
        const match_key_uri = regex('URI=".+"');
        const key = await retrieve_key_url();
        playlist_lines[line_key] = playlist_lines[line_key].replace(
          match_key_uri,
          `URI="${key}"`
        );
      }
    }

    return playlist_lines.join("\n");
  }

  /**
   * @returns {string}
   */
  async function retrieve_key_url() {
    return "https://scws.work/storage/enc.key";
  }

  /**
   *
   * @returns {int[]}
   */
  async function get_key() {
    const enc_file = await debug_get("https://scws.work/storage/enc.key");
    const encoder = new TextEncoder();
    const bytes = encoder.encode(enc_file);
    return bytes;
  }

  /**
   * @param {string} playlist
   * @returns {string}
   */
  async function get_iv(playlist) {
    const match_iv = regex("IV=0x(.+)");
    const iv_raw = playlist.match(match_iv)[1];
    const bytes = new Uint8Array(16);
    for (let i = 0; i < iv_raw.length; i += 2) {
      bytes[i / 2] = parseInt(iv_raw.substring(i, i + 2), 16);
    }
    return bytes;
  }

  async function generate_token() {
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
  }

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
   * @param {string[]} options_to_show_name
   */
  function list_options(options_table, options_to_show_name) {
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
      ` node ${app} --u "https://streamingcommunity.codes" --m "rick and morty" --s "1" --e "3" --o "sample-playlist.m3u8"`
    );
    console.log(
      ` node ${app} --u "https://streamingcommunity.codes" --m "Enola Holmes 2" --o "sample-playlist.m3u8"`
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
    for (const record of records) {
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
      const match_trailer_videos = regex(
        '<slider-trailer.+videos="(.+)".+</slider-trailer>',
        "s"
      );
      const trailer_videos = JSON.parse(
        decode_html(decoded_movie_page.match(match_trailer_videos)[1])
      );
      const trailer_url = `https://youtube.com/watch?v=${trailer_videos[0].url}`;
      const movie_infos = decoded_movie_page.match(match_infos);
      if (movie_infos) {
        const seasons = JSON.parse(decode_utf8(movie_infos[1]));

        for (const season of seasons) {
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
      /* const tmdb_id = video_player_infos.title.tmdb_id;
      const tmdb_type = video_player_infos.title.type; */
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
          scws_id,
          trailer_url
        )
      );
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
    const video_player_page = await debug_get(video_player_page_url);
    const match_video_player = regex(
      '<video-player.+response="(.+)".+video-player>',
      "s"
    );
    const video_player_infos = JSON.parse(
      decode_utf8(decode_html(video_player_page.match(match_video_player)[1]))
    );
    const scws_id = video_player_infos.scws_id;
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

  constructor(
    seasons,
    is_series,
    slug,
    id,
    images,
    plot,
    friendly_name,
    scws_id,
    trailer_url
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
   * @param {string} name
   * @param {string} alias
   * @param {boolean} has_value
   * @param {boolean} is_optional
   * @param {string} value
   */
  constructor(alias, has_value, is_optional, description) {
    this.alias = alias;
    this.has_value = has_value;
    this.is_optional = is_optional;
    this.description = description;
  }
}

main();
