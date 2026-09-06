// The names play-bot accounts are created under.
//
// They were `Rally01Bot`...`RallyNNBot`, from a zero-padded counter, and the
// problem with that is not that it looks lazy. It is that a name is the ONLY
// thing most surfaces show: the in-match opponent label, the lobby, the result
// strip, the quick-chat sender, and the denormalized `player1Name`/
// `player2Name` in match history all render a name with no BOT badge beside
// it. `RallyNNBot` disclosed everywhere by accident of spelling.
//
// A handle does not, so §4.11's disclosure requirement — the profile must
// never imply a human is behind it — moves onto the two things that are
// actually marked: the badge on the public profile card, and the shared robot
// avatar every bot carries. THOSE SHIP TOGETHER. A build with these names and
// no avatar has quietly stopped disclosing.
//
// Style rules, and each has a reason:
//
//   * HANDLES, not bare first names. "Maria" collides with a human weekly and
//     reads as a placeholder; "m_ferreira" reads as somebody who picked it.
//   * No digits in the base. A digit is the tell a generator leaves.
//   * Spread across the regions the seven shipped locales cover, because this
//     roster is furniture a player reads.
//   * At most 14 characters, so the overflow suffix below stays inside
//     USERNAME_MAX (16). `tests/playbotNames.test.ts` holds that.
//   * Nothing containing bot/cpu/npc/rally/phong, which would put the tell
//     back in the name and make the avatar redundant on some rows and not
//     others.
//
// A sibling of `server/bots.ts` in shape: a name table with the reasoning
// beside it, rather than a generator nobody can read the output of.

export const PLAYBOT_NAMES: readonly string[] = [
  'mia_ruiz', 'dtanaka', 'h_kovacs', 'wei_chen', 'jonasb', 'lucaspx', 'noemiel', 'r_okonkwo',
  'sofia_lm', 'k_haugen', 'martaviv', 'yusuf_ak', 'elena_bg', 'p_moreau', 'takeda_r', 'anand_kv',
  'lars_ov', 'chiara_n', 'omar_saf', 'nina_kw', 'jperalta', 'sung_min', 'f_bianchi', 'thabo_m',
  'lenaost', 'davi_rn', 'k_nakamura', 'irene_vb', 'moussa_d', 'pia_lund', 'rafa_ort', 's_iqbal',
  'yuki_mori', 'tomas_hk', 'adaeze_o', 'milos_pv', 'clara_fs', 'hanne_ls', 'diego_mr', 'aya_shim',
  'bruno_tv', 'zoe_arndt', 'kaveh_nz', 'lin_yuwen', 'ester_dk', 'nuno_bap', 'ilkay_ors', 'freja_sn',
  'oscar_lv', 'mei_lan', 'tariq_bn', 'valeria_c', 'jonte_kr', 'sanna_mk', 'pedro_alv', 'nadia_rf',
  'kenji_ito', 'gudrun_h', 'amir_sol', 'lucie_pn', 'kwame_ab', 'stefania', 'hugo_ptr', 'ines_mrq',
  'daniil_v', 'ayse_krm', 'ravi_shk', 'birgit_ln', 'joao_vsc', 'meera_ns', 'anton_bkv', 'linnea_s',
  'carlo_sti', 'hana_prk', 'salim_zr', 'greta_ohl', 'tiago_fer', 'yara_nsr', 'emil_brg', 'noor_hdd',
  'sergi_bas', 'kaisa_vh', 'malik_der', 'juliette', 'andres_qz', 'ffischer', 'ling_zhao', 'petra_km',
  'osman_ylk', 'rui_teix', 'agnes_hlt', 'dmitri_ks', 'leila_mnf', 'jonas_wrd', 'kirra_wln', 'tobias_r',
  'saoirse_n', 'niklas_eb', 'amara_dku', 'viktor_pl', 'chiaki_ns', 'bea_solis', 'idris_mck', 'runa_ekb',
  'gabriel_v', 'suri_patel', 'lasse_hvd', 'noel_arag', 'zeynep_gr', 'matteo_dl', 'aoife_bry', 'kenta_saw',
  'bilal_hqm', 'vera_lind', 'tomek_zbr', 'nadine_bl', 'ismael_rq', 'kaia_thms', 'rohan_dsz', 'elsa_wnk',
  'javier_ntl', 'hyeon_woo', 'marisol_v', 'dario_kpl', 'anouk_verm', 'seb_marlow', 'inaya_qsm', 'pekka_ahv',
  'cleo_baptr', 'yosef_lmn', 'talia_grnd', 'nils_rehnq', 'marek_svbd', 'lea_courtn', 'hamza_ridt', 'siri_valdn',
];

/**
 * The nth name the population asks for.
 *
 * TOTAL, and that is the whole reason this is a function rather than an index.
 * A bare `PLAYBOT_NAMES[n]` past the end is `undefined`, which stringifies to
 * "undefined" — and "undefined" PASSES the username regex. The first bot over
 * the edge would claim it, burn it out of the pool for good (an initialized
 * name is never released), and every later one would collide with it forever,
 * with nothing anywhere to say so. The counter this replaced was total for
 * every n, so losing that in the move to a list is a regression nothing else
 * in the repo would notice.
 *
 * The lap suffix starts at 2 rather than 1, so a deployment inside the list
 * length shows no suffix at all and the second lap reads as a second account
 * rather than as a rename.
 *
 * Exported so a test can take one out of the pool before the population boots
 * and watch the provisioning loop walk past it — the collision that used to
 * leave the roster short for the life of the deployment.
 */
export const defaultPlaybotName = (n: number): string => {
  const i = ((n % PLAYBOT_NAMES.length) + PLAYBOT_NAMES.length) % PLAYBOT_NAMES.length;
  const base = PLAYBOT_NAMES[i]!;
  const lap = Math.floor(n / PLAYBOT_NAMES.length);
  return lap <= 0 ? base : `${base}${lap + 1}`;
};
