window.Hyumu = window.Hyumu || {};

Hyumu.Render = (function () {
  const Model = Hyumu.Model;

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function renderHeader(container, state, handlers) {
    const { year, month, employeeId, store } = state;
    container.innerHTML = `
      <h1>휴무 자동 배정</h1>
      <div class="month-bar">
        <button type="button" id="btn-prev-month" class="btn-icon" aria-label="이전 달">◀</button>
        <span class="month-label">${year}년 ${month}월</span>
        <button type="button" id="btn-next-month" class="btn-icon" aria-label="다음 달">▶</button>
        <select id="month-jump"></select>
        <span class="header-user">${esc(store || '')} · ${esc(employeeId || '')}님</span>
        <button type="button" id="btn-logout" class="btn-icon">로그아웃</button>
      </div>
    `;
    const jump = container.querySelector('#month-jump');
    const currentKey = Model.monthKey(year, month);
    const index = await Hyumu.Storage.loadIndex(store);
    jump.innerHTML = `<option value="">저장된 달로 이동...</option>` +
      index.map((e) => `<option value="${e.key}" ${e.key === currentKey ? 'selected' : ''}>${esc(e.label)}</option>`).join('');

    container.querySelector('#btn-prev-month').addEventListener('click', () => handlers.onChangeMonth(-1));
    container.querySelector('#btn-next-month').addEventListener('click', () => handlers.onChangeMonth(1));
    container.querySelector('#btn-logout').addEventListener('click', () => handlers.onLogout());
    jump.addEventListener('change', () => {
      if (jump.value) {
        const [y, m] = jump.value.split('-').map(Number);
        handlers.onJumpMonth(y, m);
      }
    });
  }

  function renderLoginScreen(container, handlers, errorMsg) {
    container.innerHTML = `
      <section class="screen auth-screen">
        <h2>로그인</h2>
        ${errorMsg ? `<p class="warning">${esc(errorMsg)}</p>` : ''}
        <div class="field-row"><label>사번</label><input type="text" id="login-id"></div>
        <div class="field-row"><label>비밀번호</label><input type="password" id="login-pw"></div>
        <button type="button" id="btn-login" class="btn-primary btn-large">로그인</button>
        <p class="hint">계정이 없으신가요? <button type="button" id="btn-goto-signup" class="link-btn">가입하기</button></p>
      </section>
    `;
    container.querySelector('#btn-login').addEventListener('click', () => {
      handlers.onLogin(container.querySelector('#login-id').value, container.querySelector('#login-pw').value);
    });
    container.querySelector('#btn-goto-signup').addEventListener('click', () => handlers.onGotoSignup());
  }

  function renderSignupScreen(container, handlers, errorMsg) {
    const stores = Hyumu.Auth.STORE_LIST;
    container.innerHTML = `
      <section class="screen auth-screen">
        <h2>가입하기</h2>
        ${errorMsg ? `<p class="warning">${esc(errorMsg)}</p>` : ''}
        <div class="field-row"><label>점포</label>
          <select id="signup-store">
            <option value="">선택하세요</option>
            ${stores.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
          </select>
        </div>
        <div class="field-row"><label>사번</label><input type="text" id="signup-id"></div>
        <div class="field-row"><label>비밀번호</label><input type="password" id="signup-pw"></div>
        <div class="field-row"><label>휴대폰번호</label><input type="tel" id="signup-phone" placeholder="010-0000-0000"></div>
        <button type="button" id="btn-signup" class="btn-primary btn-large">가입하기</button>
        <p class="hint">이미 계정이 있으신가요? <button type="button" id="btn-goto-login" class="link-btn">로그인</button></p>
      </section>
    `;
    container.querySelector('#btn-signup').addEventListener('click', () => {
      handlers.onSignup(
        container.querySelector('#signup-id').value,
        container.querySelector('#signup-pw').value,
        container.querySelector('#signup-phone').value,
        container.querySelector('#signup-store').value
      );
    });
    container.querySelector('#btn-goto-login').addEventListener('click', () => handlers.onGotoLogin());
  }

  function renderNav(container, state, handlers) {
    const tabs = [
      { id: 'employees', label: '직원 설정' },
      { id: 'rules', label: '규칙 설정' },
      { id: 'calendar', label: '결과 캘린더' }
    ];
    container.innerHTML = tabs.map((t) =>
      `<button type="button" class="tab-btn${state.screen === t.id ? ' active' : ''}" data-screen="${t.id}">${t.label}</button>`
    ).join('');
    container.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => handlers.onNavigate(btn.dataset.screen));
    });
  }

  function renderEmployeeScreen(container, doc, handlers) {
    const rows = doc.employees.map((emp) => `
      <div class="employee-card" data-id="${emp.id}">
        <div class="employee-row">
          <input type="text" class="emp-name" value="${esc(emp.name)}" placeholder="이름" data-id="${emp.id}">
          <button type="button" class="btn-remove-emp" data-id="${emp.id}">삭제</button>
        </div>
        <div class="weekday-checks">
          ${Model.WEEKDAY_LABELS.map((label, wd) => `
            <label class="weekday-check">
              <input type="checkbox" class="emp-recurring" data-id="${emp.id}" data-wd="${wd}" ${emp.recurringOff.includes(wd) ? 'checked' : ''}>
              ${label}
            </label>
          `).join('')}
          <span class="hint">고정 휴무 요일</span>
        </div>
        <div class="shift-pref-row">
          <label class="hint">근무 시간대</label>
          <select class="emp-shift-pref" data-id="${emp.id}">
            <option value="ANY" ${emp.shiftPreference === 'ANY' ? 'selected' : ''}>상관없음</option>
            <option value="MORNING" ${emp.shiftPreference === 'MORNING' ? 'selected' : ''}>오전만</option>
            <option value="AFTERNOON" ${emp.shiftPreference === 'AFTERNOON' ? 'selected' : ''}>오후만</option>
          </select>
        </div>
        <div class="shift-pref-row">
          <label class="hint">코너</label>
          <select class="emp-corner" data-id="${emp.id}">
            <option value="" ${!emp.corner ? 'selected' : ''}>미지정</option>
            ${Object.entries(Model.CORNER_GROUPS).map(([group, corners]) => `
              <optgroup label="${esc(group)}">
                ${corners.map((c) => `<option value="${esc(c)}" ${emp.corner === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
              </optgroup>
            `).join('')}
          </select>
        </div>
        <div class="specific-off">
          <input type="date" class="emp-date-input" data-id="${emp.id}">
          <div class="date-chips">
            ${emp.specificOff.map((d) => `<span class="chip">${d} <button type="button" class="chip-remove" data-id="${emp.id}" data-date="${d}">×</button></span>`).join('')}
          </div>
        </div>
      </div>
    `).join('');

    container.innerHTML = `
      <section class="screen">
        <h2>직원 설정</h2>
        <p class="hint">고정 휴무 요일과 이미 승인된 개인 휴무 날짜만 입력하세요. 나머지는 규칙에 따라 자동으로 배정됩니다.</p>
        <div id="employee-list">${rows || '<p class="hint">아직 등록된 직원이 없습니다.</p>'}</div>
        <button type="button" id="btn-add-employee" class="btn-primary">+ 직원 추가</button>
      </section>
    `;

    container.querySelector('#btn-add-employee').addEventListener('click', () => handlers.onAddEmployee());
    container.querySelectorAll('.btn-remove-emp').forEach((btn) =>
      btn.addEventListener('click', () => handlers.onRemoveEmployee(btn.dataset.id))
    );
    container.querySelectorAll('.emp-name').forEach((input) =>
      input.addEventListener('input', () => handlers.onRenameEmployee(input.dataset.id, input.value))
    );
    container.querySelectorAll('.emp-recurring').forEach((input) =>
      input.addEventListener('change', () =>
        handlers.onToggleRecurring(input.dataset.id, Number(input.dataset.wd), input.checked)
      )
    );
    container.querySelectorAll('.emp-shift-pref').forEach((select) =>
      select.addEventListener('change', () => handlers.onUpdateShiftPreference(select.dataset.id, select.value))
    );
    container.querySelectorAll('.emp-corner').forEach((select) =>
      select.addEventListener('change', () => handlers.onUpdateCorner(select.dataset.id, select.value))
    );
    container.querySelectorAll('.emp-date-input').forEach((input) =>
      input.addEventListener('change', () => {
        if (input.value) {
          handlers.onAddSpecificOff(input.dataset.id, input.value);
        }
      })
    );
    container.querySelectorAll('.chip-remove').forEach((btn) =>
      btn.addEventListener('click', () => handlers.onRemoveSpecificOff(btn.dataset.id, btn.dataset.date))
    );
  }

  function renderRulesScreen(container, doc, handlers) {
    const rules = doc.rules;
    const n = doc.employees.length;
    const shiftMinTotal = (rules.minMorningStaff || 0) + (rules.minAfternoonStaff || 0);
    const warn = rules.minStaffDefault > n && n > 0
      ? `<p class="warning">⚠ 최소 근무 인원(${rules.minStaffDefault}명)이 전체 직원 수(${n}명)보다 많거나 같아 휴무를 배정할 여유가 없습니다.</p>`
      : '';
    const shiftWarn = shiftMinTotal > n && n > 0
      ? `<p class="warning">⚠ 오전+오후 최소 인원 합(${shiftMinTotal}명)이 전체 직원 수(${n}명)보다 많아 매일 배정이 불가능합니다.</p>`
      : '';

    container.innerHTML = `
      <section class="screen">
        <h2>규칙 설정</h2>
        ${warn}
        <div class="field-row">
          <label>기본 최소 근무 인원</label>
          <input type="number" id="rule-min-staff" min="0" value="${rules.minStaffDefault}">
        </div>
        <div class="field-row">
          <label>최대 연속 근무일수</label>
          <input type="number" id="rule-max-consecutive" min="1" value="${rules.maxConsecutiveWorkDays}">
        </div>
        ${shiftWarn}
        <div class="field-row">
          <label>오전조 최소 인원</label>
          <input type="number" id="rule-min-morning" min="0" value="${rules.minMorningStaff || 0}">
        </div>
        <div class="field-row">
          <label>오후조 최소 인원</label>
          <input type="number" id="rule-min-afternoon" min="0" value="${rules.minAfternoonStaff || 0}">
        </div>
        <div class="field-row">
          <label><input type="checkbox" id="rule-week-rest" ${rules.minRestPerWeekWindow ? 'checked' : ''}> 매 7일마다 최소 1일 휴무 보장</label>
        </div>

        <details class="rule-details">
          <summary>요일별 최소 근무 인원 예외 (선택)</summary>
          <div class="weekday-overrides">
            ${Model.WEEKDAY_LABELS.map((label, wd) => `
              <label class="weekday-override">
                ${label}
                <input type="number" min="0" class="rule-weekday-override" data-wd="${wd}"
                  value="${rules.minStaffByWeekday[wd] != null ? rules.minStaffByWeekday[wd] : ''}"
                  placeholder="기본값">
              </label>
            `).join('')}
          </div>
        </details>

        <details class="rule-details">
          <summary>코너별 최소 근무 인원 (선택)</summary>
          <div class="weekday-overrides">
            ${Object.entries(Model.CORNER_GROUPS).flatMap(([group, corners]) => corners).map((corner) => `
              <label class="weekday-override">
                ${esc(corner)}
                <input type="number" min="0" class="rule-corner-override" data-corner="${esc(corner)}"
                  value="${rules.minStaffByCorner && rules.minStaffByCorner[corner] != null ? rules.minStaffByCorner[corner] : ''}"
                  placeholder="0">
              </label>
            `).join('')}
          </div>
        </details>

        <details class="rule-details">
          <summary>특정 날짜 최소 근무 인원 예외 (선택)</summary>
          <div class="date-override-add">
            <input type="date" id="rule-date-input">
            <input type="number" min="0" id="rule-date-value" placeholder="최소 인원">
            <button type="button" id="btn-add-date-rule">추가</button>
          </div>
          <div class="date-override-list">
            ${Object.entries(rules.minStaffByDate).map(([date, val]) => `
              <span class="chip">${date}: ${val}명 <button type="button" class="date-rule-remove" data-date="${date}">×</button></span>
            `).join('')}
          </div>
        </details>

        <button type="button" id="btn-generate" class="btn-primary btn-large">휴무 생성하기</button>
      </section>
    `;

    container.querySelector('#rule-min-staff').addEventListener('change', (e) =>
      handlers.onUpdateRule('minStaffDefault', Number(e.target.value))
    );
    container.querySelector('#rule-max-consecutive').addEventListener('change', (e) =>
      handlers.onUpdateRule('maxConsecutiveWorkDays', Number(e.target.value))
    );
    container.querySelector('#rule-min-morning').addEventListener('change', (e) =>
      handlers.onUpdateRule('minMorningStaff', Number(e.target.value))
    );
    container.querySelector('#rule-min-afternoon').addEventListener('change', (e) =>
      handlers.onUpdateRule('minAfternoonStaff', Number(e.target.value))
    );
    container.querySelector('#rule-week-rest').addEventListener('change', (e) =>
      handlers.onUpdateRule('minRestPerWeekWindow', e.target.checked)
    );
    container.querySelectorAll('.rule-weekday-override').forEach((input) =>
      input.addEventListener('change', () =>
        handlers.onUpdateWeekdayOverride(Number(input.dataset.wd), input.value === '' ? null : Number(input.value))
      )
    );
    container.querySelectorAll('.rule-corner-override').forEach((input) =>
      input.addEventListener('change', () =>
        handlers.onUpdateCornerMinStaff(input.dataset.corner, input.value === '' ? null : Number(input.value))
      )
    );
    container.querySelector('#btn-add-date-rule').addEventListener('click', () => {
      const dateInput = container.querySelector('#rule-date-input');
      const valInput = container.querySelector('#rule-date-value');
      if (dateInput.value && valInput.value !== '') {
        handlers.onUpdateDateOverride(dateInput.value, Number(valInput.value));
        dateInput.value = '';
        valInput.value = '';
      }
    });
    container.querySelectorAll('.date-rule-remove').forEach((btn) =>
      btn.addEventListener('click', () => handlers.onUpdateDateOverride(btn.dataset.date, null))
    );
    container.querySelector('#btn-generate').addEventListener('click', () => handlers.onGenerate());
  }

  const SOURCE_CLASS = {
    BASE: 'cell-base',
    MANUAL: 'cell-manual',
    AUTO_FORCED: 'cell-forced',
    AUTO_FAIRNESS: 'cell-fairness',
    AUTO: 'cell-auto'
  };

  function renderCalendarScreen(container, doc, handlers) {
    const dates = Model.allDatesOfMonth(doc.month.year, doc.month.month);
    const employees = doc.employees;

    if (employees.length === 0) {
      container.innerHTML = `<section class="screen"><h2>결과 캘린더</h2><p class="hint">먼저 직원 설정에서 직원을 추가하세요.</p></section>`;
      return;
    }

    const conflictDates = new Set(doc.conflicts.filter((c) => c.date).map((c) => c.date));
    const conflictEmpDay = new Set();
    doc.conflicts.forEach((c) => {
      if (!c.date) return;
      (c.employeeIds || []).forEach((id) => conflictEmpDay.add(`${id}|${c.date}`));
    });

    const banner = doc.conflicts.length > 0 ? `
      <div class="conflict-banner">
        <strong>⚠ 이 규칙으로는 배정 불가능한 날짜가 있습니다</strong>
        <ul>${doc.conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul>
      </div>
    ` : '';

    const headerRow = `
      <tr>
        <th class="name-col">직원</th>
        ${dates.map((d) => {
          const wd = Model.weekdayOf(d);
          const day = Number(d.split('-')[2]);
          const weekendClass = wd === 0 || wd === 6 ? ' weekend-col' : '';
          const confClass = conflictDates.has(d) ? ' conflict-col' : '';
          return `<th class="${weekendClass}${confClass}">${day}<br><span class="wd-label">${Model.WEEKDAY_LABELS[wd]}</span></th>`;
        }).join('')}
        <th class="total-col">휴무</th>
        <th class="total-col">오전</th>
        <th class="total-col">오후</th>
      </tr>
    `;

    const bodyRows = employees.map((emp) => {
      const empSchedule = doc.schedule[emp.id] || {};
      let offCount = 0;
      let morningCount = 0;
      let afternoonCount = 0;
      const cells = dates.map((d) => {
        const cell = empSchedule[d] || { status: 'WORK', source: 'AUTO', shift: null };
        const wd = Model.weekdayOf(d);
        const weekendClass = wd === 0 || wd === 6 ? ' weekend-col' : '';
        const confClass = conflictEmpDay.has(`${emp.id}|${d}`) ? ' conflict-cell' : '';
        const sourceClass = SOURCE_CLASS[cell.source] || 'cell-auto';
        let text = '';
        let shiftClass = '';
        if (cell.status === 'OFF') {
          offCount++;
          text = '휴';
        } else {
          text = Model.SHIFT_LABELS[cell.shift] || '';
          shiftClass = cell.shift === 'MORNING' ? ' shift-morning' : cell.shift === 'AFTERNOON' ? ' shift-afternoon' : '';
          if (cell.shift === 'MORNING') morningCount++;
          else if (cell.shift === 'AFTERNOON') afternoonCount++;
        }
        return `<td class="cal-cell ${sourceClass}${shiftClass}${weekendClass}${confClass}" data-emp="${emp.id}" data-date="${d}" data-status="${cell.status}" data-shift="${cell.shift || ''}">${text}</td>`;
      }).join('');
      return `<tr><td class="name-col">${esc(emp.name)}</td>${cells}<td class="total-col">${offCount}</td><td class="total-col">${morningCount}</td><td class="total-col">${afternoonCount}</td></tr>`;
    }).join('');

    container.innerHTML = `
      <section class="screen screen-calendar">
        <h2>결과 캘린더</h2>
        ${banner}
        <div class="legend">
          <span class="legend-item"><span class="swatch cell-base"></span>고정휴무</span>
          <span class="legend-item"><span class="swatch cell-manual"></span>수동수정</span>
          <span class="legend-item"><span class="swatch cell-forced"></span>연속근무제한</span>
          <span class="legend-item"><span class="swatch cell-fairness"></span>자동배정</span>
          <span class="legend-item"><span class="swatch shift-morning-swatch"></span>오전</span>
          <span class="legend-item"><span class="swatch shift-afternoon-swatch"></span>오후</span>
          <span class="legend-item">셀을 클릭하면 휴무 → 오전 → 오후 순으로 직접 바꿀 수 있습니다.</span>
        </div>
        <div class="calendar-scroll">
          <table class="calendar-table">
            <thead>${headerRow}</thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
        <div class="calendar-actions">
          <button type="button" id="btn-regenerate" class="btn-primary">다시 계산</button>
          <button type="button" id="btn-reset-manual">수동 수정 초기화</button>
          <button type="button" id="btn-print">인쇄 / PDF로 저장</button>
        </div>
      </section>
    `;

    container.querySelectorAll('.cal-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        handlers.onToggleCell(cell.dataset.emp, cell.dataset.date, cell.dataset.status, cell.dataset.shift || null);
      });
    });
    container.querySelector('#btn-regenerate').addEventListener('click', () => handlers.onRegenerate());
    container.querySelector('#btn-reset-manual').addEventListener('click', () => handlers.onResetManual());
    container.querySelector('#btn-print').addEventListener('click', () => window.print());
  }

  return {
    renderHeader,
    renderNav,
    renderEmployeeScreen,
    renderRulesScreen,
    renderCalendarScreen,
    renderLoginScreen,
    renderSignupScreen
  };
})();
