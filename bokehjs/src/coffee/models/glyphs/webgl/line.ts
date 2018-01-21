/* XXX: partial */
import {Program, VertexBuffer, IndexBuffer, Texture2D} from "gloo2"
import {BaseGLGlyph} from "./base";
import {vertex_shader} from "./line.vert"
import {fragment_shader} from "./line.frag"
import {color2rgba} from "core/util/color"

class DashAtlas {

  constructor(gl) {
    this._atlas = {};
    this._index = 0;
    this._width = 256;
    this._height = 256;
    // Init texture
    this.tex = new Texture2D(gl);
    this.tex.set_wrapping(gl.REPEAT, gl.REPEAT);
    this.tex.set_interpolation(gl.NEAREST, gl.NEAREST);
    this.tex.set_size([this._height, this._width], gl.RGBA);
    this.tex.set_data([0, 0], [this._height, this._width], new Uint8Array(this._height * this._width * 4));
    // Init with solid line (index 0 is reserved for this)
    this.get_atlas_data([1]);
  }

  get_atlas_data(pattern) {
    const key = pattern.join('-');
    const findex_period = this._atlas[key];
    if (findex_period === undefined) {
      const [data, period] = this.make_pattern(pattern);
      this.tex.set_data([this._index, 0], [1, this._width], new Uint8Array(data.map((x) => x+10)));
      this._atlas[key] = [this._index / this._height, period];
      this._index += 1;
    }
    return this._atlas[key];
  }

  make_pattern(pattern) {
    // A pattern is defined as on/off sequence of segments
    // It must be a multiple of 2
    let i;
    let end;
    let asc, end1;
    if ((pattern.length > 1) && (pattern.length % 2)) {
      pattern = pattern.concat(pattern);
    }
    // Period is sum of elements
    let period = 0;
    for (const v of pattern) {
       period += v;
    }
    // Find all start and end of on-segment only
    const C: number[] = []; let c = 0;
    for (i = 0, end = pattern.length+2; i < end; i += 2) {
      const a = Math.max(0.0001, pattern[i % pattern.length]);
      const b = Math.max(0.0001, pattern[(i+1) % pattern.length]);
      C.push(c, c + a)
      c += a + b;
    }
    // Build pattern
    const n = this._width;
    const Z = new Float32Array(n * 4);
    for (i = 0, end1 = n, asc = 0 <= end1; asc ? i < end1 : i > end1; asc ? i++ : i--) {
      let dash_end, dash_start, dash_type;
      const x = (period * i) / (n-1);
      // get index at min - index = np.argmin(abs(C-(x)))
      let index = 0; let val_at_index = 1e16;
      for (let j = 0, end2 = C.length, asc1 = 0 <= end2; asc1 ? j < end2 : j > end2; asc1 ? j++ : j--) {
        const val = Math.abs(C[j]-x);
        if (val < val_at_index) {
           index = j; val_at_index = val;
         }
      }
      if ((index % 2) === 0) {
        dash_type = (x <= C[index]) ? +1 : 0;
        dash_start = C[index]; dash_end = C[index+1];
      } else {
        dash_type = (x > C[index]) ? -1 : 0;
        dash_start = C[index-1]; dash_end = C[index];
      }
      Z[(i*4)+0] = C[index];
      Z[(i*4)+1] = dash_type;
      Z[(i*4)+2] = dash_start;
      Z[(i*4)+3] = dash_end;
    }
    return [Z, period];
  }
}

export class LineGLGlyph extends BaseGLGlyph {

    static initClass() {
      this.prototype.GLYPH = 'line';

      this.prototype.JOINS =
        {'miter': 0, 'round': 1, 'bevel': 2};

      this.prototype.CAPS = {
        '': 0, 'none': 0, '.': 0,
        'round': 1, ')': 1, '(': 1, 'o': 1,
        'triangle in': 2, '<': 2,
        'triangle out': 3, '>': 3,
        'square': 4, '[': 4, ']': 4, '=': 4,
        'butt': 5, '|': 5
      };

      this.prototype.VERT = vertex_shader

      this.prototype.FRAG = fragment_shader
    }

    init(): void {
      const {gl} = this;
      this._scale_aspect = 0;  // keep track, so we know when we need to update segment data

      // The program
      this.prog = new Program(gl);
      this.prog.set_shaders(this.VERT, this.FRAG);
      this.index_buffer = new IndexBuffer(gl);
      // Buffers
      this.vbo_position = new VertexBuffer(gl);
      this.vbo_tangents = new VertexBuffer(gl);
      this.vbo_segment = new VertexBuffer(gl);
      this.vbo_angles = new VertexBuffer(gl);
      this.vbo_texcoord = new VertexBuffer(gl);
      // Dash atlas
      this.dash_atlas = new DashAtlas(gl);
    }

    draw(indices, mainGlyph, trans) {
      const mainGlGlyph = mainGlyph.glglyph;

      if (mainGlGlyph.data_changed) {
        if (!(isFinite(trans.dx) && isFinite(trans.dy))) {
          return;  // not sure why, but it happens on init sometimes (#4367)
        }
        mainGlGlyph._baked_offset = [trans.dx, trans.dy];  // float32 precision workaround; used in _bake() and below
        mainGlGlyph._set_data();
        mainGlGlyph.data_changed = false;
      }
      if (this.visuals_changed) {
        this._set_visuals();
        this.visuals_changed = false;
      }

      // Decompose x-y scale into scalar scale and aspect-vector.
      let { sx } = trans; let { sy } = trans;
      const scale_length = Math.sqrt((sx * sx) + (sy * sy));
      sx /= scale_length; sy /= scale_length;

      // Do we need to re-calculate segment data and cumsum?
      if (Math.abs(this._scale_aspect - (sy / sx)) > Math.abs(1e-3 * this._scale_aspect)) {
        mainGlGlyph._update_scale(sx, sy);
        this._scale_aspect = sy / sx;
      }

      // Select buffers from main glyph
      // (which may be this glyph but maybe not if this is a (non)selection glyph)
      this.prog.set_attribute('a_position', 'vec2', mainGlGlyph.vbo_position);
      this.prog.set_attribute('a_tangents', 'vec4', mainGlGlyph.vbo_tangents);
      this.prog.set_attribute('a_segment', 'vec2', mainGlGlyph.vbo_segment);
      this.prog.set_attribute('a_angles', 'vec2', mainGlGlyph.vbo_angles);
      this.prog.set_attribute('a_texcoord', 'vec2', mainGlGlyph.vbo_texcoord);
      //
      this.prog.set_uniform('u_length', 'float', [mainGlGlyph.cumsum]);
      this.prog.set_texture('u_dash_atlas', this.dash_atlas.tex);

      // Handle transformation to device coordinates
      const baked_offset = mainGlGlyph._baked_offset;
      this.prog.set_uniform('u_pixel_ratio', 'float', [trans.pixel_ratio]);
      this.prog.set_uniform('u_canvas_size', 'vec2', [trans.width, trans.height]);
      this.prog.set_uniform('u_offset', 'vec2', [trans.dx - baked_offset[0], trans.dy - baked_offset[1]]);
      this.prog.set_uniform('u_scale_aspect', 'vec2', [sx, sy]);
      this.prog.set_uniform('u_scale_length', 'float', [scale_length]);

      this.I_triangles = mainGlGlyph.I_triangles;
      if (this.I_triangles.length < 65535) {
        // Data is small enough to draw in one pass
        this.index_buffer.set_size(this.I_triangles.length*2);
        this.index_buffer.set_data(0, new Uint16Array(this.I_triangles));
        return this.prog.draw(this.gl.TRIANGLES, this.index_buffer);
        // @prog.draw(@gl.LINE_STRIP, @index_buffer)  # Use this to draw the line skeleton
      } else {
        // Work around the limit that the indexbuffer must be uint16. We draw in chunks.
        // First collect indices in chunks
        let chunk, i;
        let asc, end;
        let asc1, end1;
        indices = this.I_triangles;
        const nvertices = this.I_triangles.length;
        const chunksize = 64008;  // 65536 max. 64008 is divisible by 12
        const chunks = [];
        for (i = 0, end = Math.ceil(nvertices/chunksize), asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
           chunks.push([]);
        }
        for (i = 0, end1 = indices.length, asc1 = 0 <= end1; asc1 ? i < end1 : i > end1; asc1 ? i++ : i--) {
          const uint16_index = indices[i] % chunksize;
          chunk = Math.floor(indices[i] / chunksize);
          chunks[chunk].push(uint16_index);
        }
        // Then draw each chunk
        let asc2, end2;
        for (chunk = 0, end2 = chunks.length, asc2 = 0 <= end2; asc2 ? chunk < end2 : chunk > end2; asc2 ? chunk++ : chunk--) {
          const these_indices = new Uint16Array(chunks[chunk]);
          const offset = chunk * chunksize * 4;
          if (these_indices.length === 0) {
            continue;
          }
          this.prog.set_attribute('a_position', 'vec2', mainGlGlyph.vbo_position, 0, offset * 2);
          this.prog.set_attribute('a_tangents', 'vec4', mainGlGlyph.vbo_tangents, 0, offset * 4);
          this.prog.set_attribute('a_segment', 'vec2', mainGlGlyph.vbo_segment, 0, offset * 2);
          this.prog.set_attribute('a_angles', 'vec2', mainGlGlyph.vbo_angles, 0, offset * 2);
          this.prog.set_attribute('a_texcoord', 'vec2', mainGlGlyph.vbo_texcoord, 0, offset * 2);
          // The actual drawing
          this.index_buffer.set_size(these_indices.length*2);
          this.index_buffer.set_data(0, these_indices);
          this.prog.draw(this.gl.TRIANGLES, this.index_buffer);
        }
      }
    }

    _set_data() {
      this._bake();

      this.vbo_position.set_size(this.V_position.length*4);
      this.vbo_position.set_data(0, this.V_position);

      this.vbo_tangents.set_size(this.V_tangents.length*4);
      this.vbo_tangents.set_data(0, this.V_tangents);

      this.vbo_angles.set_size(this.V_angles.length*4);
      this.vbo_angles.set_data(0, this.V_angles);

      this.vbo_texcoord.set_size(this.V_texcoord.length*4);
      return this.vbo_texcoord.set_data(0, this.V_texcoord);
    }

    _set_visuals() {

      const color = color2rgba(this.glyph.visuals.line.line_color.value(), this.glyph.visuals.line.line_alpha.value());
      const cap = this.CAPS[this.glyph.visuals.line.line_cap.value()];
      const join = this.JOINS[this.glyph.visuals.line.line_join.value()];

      this.prog.set_uniform('u_color', 'vec4', color);
      this.prog.set_uniform('u_linewidth', 'float', [this.glyph.visuals.line.line_width.value()]);
      this.prog.set_uniform('u_antialias', 'float', [0.9]);  // Smaller aa-region to obtain crisper images

      this.prog.set_uniform('u_linecaps', 'vec2', [cap, cap]);
      this.prog.set_uniform('u_linejoin', 'float', [join]);
      this.prog.set_uniform('u_miter_limit', 'float', [10.0]);  // 10 should be a good value
      // https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/stroke-miterlimit

      const dash_pattern = this.glyph.visuals.line.line_dash.value();
      let dash_index = 0; let dash_period = 1;
      if (dash_pattern.length) {
        [dash_index, dash_period] = this.dash_atlas.get_atlas_data(dash_pattern);
      }
      this.prog.set_uniform('u_dash_index', 'float', [dash_index]);  // 0 means solid line
      this.prog.set_uniform('u_dash_phase', 'float', [this.glyph.visuals.line.line_dash_offset.value()]);
      this.prog.set_uniform('u_dash_period', 'float', [dash_period]);
      this.prog.set_uniform('u_dash_caps', 'vec2', [cap, cap]);
      return this.prog.set_uniform('u_closed', 'float', [0]);  // We dont do closed lines
    }

    _bake() {
      // This is what you get if you port 50 lines of numpy code to JS.
      // V_segment is handled in another method, because it depends on the aspect
      // ratio of the scale (The original paper/code assumed isotropic scaling).
      //
      // Buffer dtype from the Python implementation:
      //
      // self.vtype = np.dtype( [('a_position', 'f4', 2),
      //                         ('a_segment',  'f4', 2),
      //                         ('a_angles',   'f4', 2),
      //                         ('a_tangents', 'f4', 4),
      //                         ('a_texcoord', 'f4', 2) ])

      // Init array of implicit shape nx2
      let i, I, T, V_angles2, V_position2, V_tangents2, V_texcoord2, Vp, Vt;
      let asc, end;
      let asc1, end1;
      let asc2, end2;
      let asc3, end3;
      let asc4, end4;
      let asc5, end5;
      let asc6, end6;
      const n = this.nvertices;
      const _x = new Float64Array(this.glyph._x);
      const _y = new Float64Array(this.glyph._y);

      // Init vertex data
      const V_position = (Vp = new Float32Array(n*2));
      //V_segment = new Float32Array(n*2)  # Done later
      const V_angles = new Float32Array(n*2);
      const V_tangents = (Vt = new Float32Array(n*4));  // mind the 4!

      // Position
      for (i = 0, end = n, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
        V_position[(i*2)+0] = _x[i] + this._baked_offset[0];
        V_position[(i*2)+1] = _y[i] + this._baked_offset[1];
      }

      // Tangents & norms (need tangents to calculate segments based on scale)
      this.tangents = (T = new Float32Array((n*2)-2));
      for (i = 0, end1 = n-1, asc1 = 0 <= end1; asc1 ? i < end1 : i > end1; asc1 ? i++ : i--) {
        T[(i*2)+0] = Vp[((i+1)*2)+0] - Vp[(i*2)+0];
        T[(i*2)+1] = Vp[((i+1)*2)+1] - Vp[(i*2)+1];
      }

      for (i = 0, end2 = n-1, asc2 = 0 <= end2; asc2 ? i < end2 : i > end2; asc2 ? i++ : i--) {
        // V['a_tangents'][+1:, :2] = T
        V_tangents[((i+1)*4)+0] = T[(i*2)+0];
        V_tangents[((i+1)*4)+1] = T[(i*2)+1];
        // V['a_tangents'][:-1, 2:] = T
        V_tangents[(i*4)+2] = T[(i*2)+0];
        V_tangents[(i*4)+3] = T[(i*2)+1];
      }

      // V['a_tangents'][0  , :2] = T[0]
      V_tangents[(0*4)+0] = T[0];
      V_tangents[(0*4)+1] = T[1];
      // V['a_tangents'][ -1, 2:] = T[-1]
      V_tangents[((n-1)*4)+2] = T[((n-2)*2)+0];
      V_tangents[((n-1)*4)+3] = T[((n-2)*2)+1];

      // Angles
      const A = new Float32Array(n);
      for (i = 0, end3 = n, asc3 = 0 <= end3; asc3 ? i < end3 : i > end3; asc3 ? i++ : i--) {
        A[i] = Math.atan2((Vt[(i*4)+0]*Vt[(i*4)+3]) - (Vt[(i*4)+1]*Vt[(i*4)+2]),
                          (Vt[(i*4)+0]*Vt[(i*4)+2]) + (Vt[(i*4)+1]*Vt[(i*4)+3]));
      }
      for (i = 0, end4 = n-1, asc4 = 0 <= end4; asc4 ? i < end4 : i > end4; asc4 ? i++ : i--) {
        V_angles[(i*2)+0] = A[i];
        V_angles[(i*2)+1] = A[i+1];
      }

      // Step 1: A -- B -- C  =>  A -- B, B' -- C

      // Repeat our array 4 times
      const m = (4 * n) - 4;
      this.V_position = (V_position2 = new Float32Array(m*2));
      this.V_angles = (V_angles2 = new Float32Array(m*2));
      this.V_tangents = (V_tangents2 = new Float32Array(m*4));  // mind the 4!
      this.V_texcoord = (V_texcoord2 = new Float32Array(m*2));
      const o = 2;
      //
      // Arg, we really need an ndarray thing in JS :/
      for (i = 0, end5 = n, asc5 = 0 <= end5; asc5 ? i < end5 : i > end5; asc5 ? i++ : i--) {  // all nodes on the line
         for (let j = 0; j < 4; j++) {  // the four quad vertices
            var k;
            for (k = 0; k < 2; k++) {  // xy
              V_position2[((((i*4)+j)-o)*2)+k] = V_position[(i*2)+k];
              V_angles2[(((i*4)+j)*2)+k] = V_angles[(i*2)+k];
          }  // no offset
            for (k = 0; k < 4; k++) {
              V_tangents2[((((i*4)+j)-o)*4)+k] = V_tangents[(i*4)+k];
          }
        }
      }

      for (i = 0, end6 = n, asc6 = 0 <= end6; asc6 ? i <= end6 : i >= end6; asc6 ? i++ : i--) {
        V_texcoord2[(((i*4)+0)*2)+0] = -1;
        V_texcoord2[(((i*4)+1)*2)+0] = -1;
        V_texcoord2[(((i*4)+2)*2)+0] = +1;
        V_texcoord2[(((i*4)+3)*2)+0] = +1;
        //
        V_texcoord2[(((i*4)+0)*2)+1] = -1;
        V_texcoord2[(((i*4)+1)*2)+1] = +1;
        V_texcoord2[(((i*4)+2)*2)+1] = -1;
        V_texcoord2[(((i*4)+3)*2)+1] = +1;
      }

      // Indices
      //I = np.resize( np.array([0,1,2,1,2,3], dtype=np.uint32), (n-1)*(2*3))
      //I += np.repeat( 4*np.arange(n-1), 6)
      const ni = (n-1) * 6;
      this.I_triangles = (I = new Uint32Array(ni));
      // Order of indices is such that drawing as line_strip reveals the line skeleton
      // Might have implications on culling, if we ever turn that on.
      // Order in paper was: 0 1 2 1 2 3
      let asc7, end7;
      for (i = 0, end7 = n, asc7 = 0 <= end7; asc7 ? i < end7 : i > end7; asc7 ? i++ : i--) {
        I[(i*6)+0] = 0 + (4*i);
        I[(i*6)+1] = 1 + (4*i);
        I[(i*6)+2] = 3 + (4*i);
        I[(i*6)+3] = 2 + (4*i);
        I[(i*6)+4] = 0 + (4*i);
        I[(i*6)+5] = 3 + (4*i);
      }
    }

    _update_scale(sx, sy) {
      // Update segment data and cumsum so the length along the line has the
      // scale aspect ratio in it. In the vertex shader we multiply with the
      // "isotropic part" of the scale.

      let i, V_segment2;
      let asc, end;
      let asc1, end1;
      let asc2, end2;
      const n = this.nvertices;
      const m = (4 * n) - 4;
      // Prepare arrays
      const T = this.tangents;
      const N = new Float32Array(n-1);
      const V_segment = new Float32Array(n*2);  // Elements are initialized with 0
      this.V_segment = (V_segment2 = new Float32Array(m*2));
      // Calculate vector lengths - with scale aspect ratio taken into account
      for (i = 0, end = n-1, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
        N[i] = Math.sqrt(Math.pow(T[(i*2)+0] * sx, 2) + Math.pow(T[(i*2)+1] * sy, 2));
      }
      // Calculate Segments
      let cumsum = 0;
      for (i = 0, end1 = n-1, asc1 = 0 <= end1; asc1 ? i < end1 : i > end1; asc1 ? i++ : i--) {
        cumsum += N[i];
        V_segment[((i+1)*2)+0] = cumsum;
        V_segment[(i*2)+1] = cumsum;
      }
      // Upscale (same loop as in _bake())
      for (i = 0, end2 = n, asc2 = 0 <= end2; asc2 ? i < end2 : i > end2; asc2 ? i++ : i--) {
         for (let j = 0; j < 4; j++) {
            for (let k = 0; k < 2; k++) {
              V_segment2[(((i*4)+j)*2)+k] = V_segment[(i*2)+k];
          }
        }
      }
      // Update
      this.cumsum = cumsum;  // L[-1] in Nico's code
      this.vbo_segment.set_size(this.V_segment.length*4);
      return this.vbo_segment.set_data(0, this.V_segment);
    }
  }
LineGLGlyph.initClass();
