window.Hyumu = window.Hyumu || {};

Hyumu.Render = (function () {
  const Model = Hyumu.Model;

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // 필수 = 스케줄러가 절대 깨지 않는 하드 조건, 권장 = 최대한 지키되 다른 필수 조건과
  // 충돌하면 양보될 수 있는 소프트 조건. 규칙 화면에서 사장님이 한눈에 구분하도록 표시.
  function ruleBadge(type) {
    return type === 'required'
      ? '<span class="rule-badge rule-badge-required">필수</span>'
      : '<span class="rule-badge rule-badge-recommended">권장</span>';
  }

  let openCalendarPopup = null;

  function closeCalendarPopup() {
    if (openCalendarPopup) {
      openCalendarPopup.remove();
      openCalendarPopup = null;
      document.removeEventListener('mousedown', handleOutsideCalendarClick, true);
    }
  }

  function handleOutsideCalendarClick(e) {
    if (openCalendarPopup && !openCalendarPopup.contains(e.target)) {
      closeCalendarPopup();
    }
  }

  function openConflictPopup(anchorEl, date, messages) {
    closeCalendarPopup();
    const popup = document.createElement('div');
    popup.className = 'custom-calendar-popup conflict-popup';
    popup.innerHTML = `
      <div class="cc-header">
        <span class="cc-title conflict-popup-title">${date} 문제</span>
        <button type="button" class="cc-nav" id="conflict-popup-close">×</button>
      </div>
      <ul class="conflict-popup-list">
        ${messages.map((m) => `<li>${esc(m)}</li>`).join('')}
      </ul>
    `;
    document.body.appendChild(popup);
    openCalendarPopup = popup;
    popup.querySelector('#conflict-popup-close').addEventListener('click', () => closeCalendarPopup());

    const dragHandle = popup.querySelector('.cc-header');
    dragHandle.classList.add('conflict-popup-drag-handle');
    dragHandle.addEventListener('mousedown', (e) => {
      if (e.target.closest('#conflict-popup-close')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = popup.offsetLeft;
      const startTop = popup.offsetTop;
      function onMove(moveEvent) {
        popup.style.left = `${startLeft + (moveEvent.clientX - startX)}px`;
        popup.style.top = `${startTop + (moveEvent.clientY - startY)}px`;
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    popup.style.position = 'fixed';
    const rect = anchorEl.getBoundingClientRect();
    const margin = 8;
    const popupW = popup.offsetWidth;
    const popupH = popup.offsetHeight;

    let left = rect.left;
    if (left + popupW > window.innerWidth - margin) {
      left = window.innerWidth - margin - popupW;
    }
    if (left < margin) left = margin;

    let top = rect.bottom + 6;
    if (top + popupH > window.innerHeight - margin) {
      const above = rect.top - 6 - popupH;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - popupH);
    }

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.maxHeight = `${window.innerHeight - margin * 2}px`;
    popup.style.overflowY = 'auto';

    setTimeout(() => document.addEventListener('mousedown', handleOutsideCalendarClick, true), 0);
  }

  // 이 직원에게 이미 저장된 개인 휴무(specificOff)와 MANUAL로 지정해둔 근무(오전/오후 확정,
  // 반차, 런런)를 달력 다중선택 팝업이 바로 보여줄 수 있는 {날짜: 종류} 형태로 모은다.
  function buildInitialCalendarSelections(emp, doc) {
    const sel = {};
    (emp.specificOff || []).forEach((d) => {
      sel[d] = Model.leaveTypeOf(emp, d);
    });
    const empSchedule = doc.schedule[emp.id] || {};
    Object.keys(empSchedule).forEach((d) => {
      const cell = empSchedule[d];
      if (!cell || cell.source !== 'MANUAL' || cell.status !== 'WORK') return;
      if (cell.runrun) sel[d] = 'RUNRUN';
      else if (cell.halfDayLeave === 'MORNING') sel[d] = 'HALF_MORNING';
      else if (cell.halfDayLeave === 'AFTERNOON') sel[d] = 'HALF_AFTERNOON';
      else if (cell.shift === 'MORNING') sel[d] = 'MORNING';
      else if (cell.shift === 'AFTERNOON') sel[d] = 'AFTERNOON';
    });
    return sel;
  }

  function openCustomCalendar(anchorEl, initialDateStr, onSelect, onSelectRange, onMultiSelect, initialSelections) {
    closeCalendarPopup();
    const today = new Date();
    let [y, m] = initialDateStr
      ? initialDateStr.split('-').map(Number)
      : [today.getFullYear(), today.getMonth() + 1];
    let rangeMode = false;
    let rangeStart = null;
    // 여러 날짜를 한 번에 고르고 싶을 때(onMultiSelect가 있을 때), 위에서 휴무 종류(연차/체단/
    // 인정/오전반차/오후반차/런런/휴무) 버튼을 먼저 고르고 달력 날짜를 누른다. "휴무"만 예전처럼
    // 휴무 → 오전 → 오후 → (선택 해제) 순으로 더 돌릴 수 있고(사장님 지시: "한 번누르면 휴무
    // 두번누르면 오전 세번 누르면 오후"), 나머지(연차/체단/인정/오전반차/오후반차/런런)는 런런처럼
    // 한 번 누르면 그 항목으로 설정, 두 번 누르면 바로 해제되는 단순 토글이다(사장님 지시:
    // "휴무 제외하고는 런런처럼 한 번 눌렀을 때 해당 메뉴만 설정되고 두번 눌렀을 때 해제").
    const TOGGLE_ONLY_TYPES = ['ANNUAL', 'CHEDAN', 'RECOGNIZED', 'HALF_MORNING', 'HALF_AFTERNOON', 'RUNRUN'];
    const LEAVE_TYPE_BUTTONS = [
      { key: 'PERSONAL', label: '휴무' },
      { key: 'ANNUAL', label: '연차' },
      { key: 'CHEDAN', label: '체단' },
      { key: 'RECOGNIZED', label: '인정' },
      { key: 'HALF_MORNING', label: '오전반차' },
      { key: 'HALF_AFTERNOON', label: '오후반차' },
      { key: 'RUNRUN', label: '런런 (2시간 조기퇴근)' }
    ];
    const MULTI_LABEL = {
      PERSONAL: '휴', ANNUAL: '연차', CHEDAN: '체단', RECOGNIZED: '인정',
      HALF_MORNING: '오전반', HALF_AFTERNOON: '오후반', MORNING: '전', AFTERNOON: '후', RUNRUN: '런런'
    };
    let selectedLeaveType = 'PERSONAL';
    // 이미 저장돼 있는 개인 휴무/근무 지정을 열자마자 보여주고 그 자리에서 바로 수정할 수
    // 있게, 넘겨받은 기존 값으로 미리 채워둔다(사장님 지시: "개인 휴무 날짜 추가를 누르면
    // 기존게 안 뜨는데 뜨게 해줬으면 좋겠어. 기존거도 수정가능하게").
    const multiSelections = Object.assign({}, initialSelections);

    const popup = document.createElement('div');
    popup.className = 'custom-calendar-popup';
    document.body.appendChild(popup);
    openCalendarPopup = popup;

    function renderMonth() {
      const first = new Date(y, m - 1, 1);
      const startWeekday = first.getDay();
      const numDays = Model.daysInMonth(y, m);
      const cells = [];
      for (let i = 0; i < startWeekday; i++) cells.push('<span class="cc-day cc-empty"></span>');
      for (let d = 1; d <= numDays; d++) {
        const dateStr = Model.dateISO(y, m, d);
        const isToday = dateStr === Model.dateISO(today.getFullYear(), today.getMonth() + 1, today.getDate());
        const isRangeStart = rangeMode && rangeStart === dateStr;
        const picked = multiSelections[dateStr];
        const pickedClass = picked ? ` cc-picked cc-picked-${picked}` : '';
        const pickedBadge = picked ? `<span class="cc-pick-badge">${MULTI_LABEL[picked]}</span>` : '';
        cells.push(`<button type="button" class="cc-day${isToday ? ' cc-today' : ''}${isRangeStart ? ' cc-range-start' : ''}${pickedClass}" data-date="${dateStr}">${d}${pickedBadge}</button>`);
      }
      const rangeHint = !onSelectRange ? '' : rangeMode
        ? `<p class="cc-range-hint">${rangeStart ? `시작일 ${rangeStart} · 종료일을 선택하세요` : '시작일을 선택하세요'}</p>`
        : '';
      const multiHint = onMultiSelect && !rangeMode
        ? '<p class="cc-range-hint">"휴무"는 날짜를 누를 때마다 휴무 → 오전 → 오후 → 선택해제 순으로 바뀌고, 나머지(연차/체단/인정/오전반차/오후반차/런런)는 한 번 누르면 설정, 두 번 누르면 해제돼요. 다 고르면 완료를 누르세요.</p>'
        : '';
      const leaveTypeButtons = onMultiSelect && !rangeMode
        ? `<div class="cc-leave-type-row">
            ${LEAVE_TYPE_BUTTONS.map((t) => `<button type="button" class="cc-leave-type-btn${selectedLeaveType === t.key ? ' active' : ''}" data-type="${t.key}">${t.label}</button>`).join('')}
          </div>`
        : '';
      const multiSelectedCount = Object.keys(multiSelections).length;
      popup.innerHTML = `
        <div class="cc-header">
          <button type="button" class="cc-nav" id="cc-prev">‹</button>
          <span class="cc-title">${y}년 ${m}월</span>
          <button type="button" class="cc-nav" id="cc-next">›</button>
        </div>
        <div class="cc-weekdays">
          ${Model.WEEKDAY_LABELS.map((l) => `<span class="cc-wd">${l}</span>`).join('')}
        </div>
        ${leaveTypeButtons}
        <div class="cc-grid">${cells.join('')}</div>
        ${onSelectRange ? `<label class="cc-range-toggle"><input type="checkbox" id="cc-range-mode" ${rangeMode ? 'checked' : ''}> 기간으로 선택 (여러 날짜 한번에)</label>` : ''}
        ${rangeHint}
        ${multiHint}
        <div class="cc-footer">
          <button type="button" class="cc-link" id="cc-today-btn">오늘</button>
          ${onMultiSelect && !rangeMode && multiSelectedCount > 0 ? '<button type="button" class="cc-link" id="cc-reset-btn">선택 초기화</button>' : ''}
          ${onMultiSelect && !rangeMode ? `<button type="button" class="btn-primary" id="cc-done-btn" ${multiSelectedCount === 0 ? 'disabled' : ''}>완료 (${multiSelectedCount})</button>` : ''}
          <button type="button" class="cc-link" id="cc-close-btn">닫기</button>
        </div>
      `;
      popup.querySelector('#cc-prev').addEventListener('click', () => {
        m -= 1; if (m < 1) { m = 12; y -= 1; }
        renderMonth();
      });
      popup.querySelector('#cc-next').addEventListener('click', () => {
        m += 1; if (m > 12) { m = 1; y += 1; }
        renderMonth();
      });
      popup.querySelector('#cc-today-btn').addEventListener('click', () => {
        y = today.getFullYear(); m = today.getMonth() + 1;
        renderMonth();
      });
      popup.querySelector('#cc-close-btn').addEventListener('click', () => closeCalendarPopup());
      const doneBtn = popup.querySelector('#cc-done-btn');
      if (doneBtn) {
        doneBtn.addEventListener('click', () => {
          if (Object.keys(multiSelections).length === 0) return;
          onMultiSelect({ ...multiSelections });
          closeCalendarPopup();
        });
      }
      const resetBtn = popup.querySelector('#cc-reset-btn');
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          Object.keys(multiSelections).forEach((k) => delete multiSelections[k]);
          renderMonth();
        });
      }
      const rangeToggle = popup.querySelector('#cc-range-mode');
      if (rangeToggle) {
        rangeToggle.addEventListener('change', () => {
          rangeMode = rangeToggle.checked;
          rangeStart = null;
          renderMonth();
        });
      }
      popup.querySelectorAll('.cc-leave-type-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedLeaveType = btn.dataset.type;
          renderMonth();
        });
      });
      popup.querySelectorAll('.cc-day[data-date]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (rangeMode) {
            if (!rangeStart) {
              rangeStart = btn.dataset.date;
              renderMonth();
            } else {
              const a = rangeStart;
              const b = btn.dataset.date;
              onSelectRange(a < b ? a : b, a < b ? b : a);
              closeCalendarPopup();
            }
          } else if (onMultiSelect) {
            const date = btn.dataset.date;
            const current = multiSelections[date];
            if (!current) {
              multiSelections[date] = selectedLeaveType;
            } else if (TOGGLE_ONLY_TYPES.includes(current)) {
              delete multiSelections[date];
            } else if (current === 'PERSONAL') {
              multiSelections[date] = 'MORNING';
            } else if (current === 'MORNING') {
              multiSelections[date] = 'AFTERNOON';
            } else {
              delete multiSelections[date];
            }
            renderMonth();
          } else {
            onSelect(btn.dataset.date);
            closeCalendarPopup();
          }
        });
      });
    }
    renderMonth();

    popup.style.position = 'fixed';
    const rect = anchorEl.getBoundingClientRect();
    const margin = 8;
    const popupW = popup.offsetWidth;
    const popupH = popup.offsetHeight;

    let left = rect.left;
    if (left + popupW > window.innerWidth - margin) {
      left = window.innerWidth - margin - popupW;
    }
    if (left < margin) left = margin;

    let top = rect.bottom + 6;
    if (top + popupH > window.innerHeight - margin) {
      const above = rect.top - 6 - popupH;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - popupH);
    }

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.maxHeight = `${window.innerHeight - margin * 2}px`;
    popup.style.overflowY = 'auto';

    setTimeout(() => document.addEventListener('mousedown', handleOutsideCalendarClick, true), 0);
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
    const dates = Model.allDatesOfMonth(doc.month.year, doc.month.month);
    const rows = doc.employees.map((emp) => {
      const empSchedule = doc.schedule[emp.id] || {};
      // 그날 실제로 근무하게 될지는 스케줄을 다시 돌리기 전엔 아무도 모르니, 근무 확정 여부와
      // 무관하게 이번 달 모든 공휴일에 대해 미리 골라둘 수 있게 한다(사장님 지시: "본인이
      // 빨간날에 근무할지 안 할지는 아무도 모르니까 일단 설정은 모두에게 뜨게").
      const holidayDates = dates.filter((d) => Model.holidayName(d));
      const holidayChoiceHtml = holidayDates.length > 0 ? `
        <div class="specific-off">
          <label class="hint">공휴일 근무 처리 (수당 또는 대체휴일 미리 선택)</label>
          ${holidayDates.map((d) => {
            const choice = Model.holidayChoiceOf(emp, empSchedule, d);
            const cell = empSchedule[d];
            const workNote = cell && cell.status === 'WORK' ? ' · 근무 예정' : cell && cell.status === 'OFF' ? ' · 휴무 예정' : '';
            return `
            <div class="holiday-choice-row">
              <span>${d} (${esc(Model.holidayName(d))}${workNote})</span>
              <select class="emp-holiday-choice" data-id="${emp.id}" data-date="${d}">
                <option value="" ${choice === '' ? 'selected' : ''}>미정</option>
                <option value="PAY" ${choice === 'PAY' ? 'selected' : ''}>수당</option>
                <option value="SUBSTITUTE" ${choice === 'SUBSTITUTE' ? 'selected' : ''}>대체휴일 (근무 시 +1 목표휴무일)</option>
              </select>
            </div>
          `;
          }).join('')}
        </div>
      ` : '';
      return `
      <div class="employee-card" data-id="${emp.id}" data-corners="${esc(JSON.stringify(Model.employeeCorners(emp)))}">
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
          <label class="corner-filter-check">
            <input type="checkbox" class="emp-edge-shift-pref" data-id="${emp.id}" ${emp.edgeShiftPreference ? 'checked' : ''}>
            쉬는 날 전엔 오전, 복귀날엔 오후 선호
          </label>
        </div>
        <div class="shift-pref-row emp-corner-row">
          <label class="hint">코너 (여러 개 담당 가능)</label>
          <div class="emp-corner-checks">
            ${Object.entries(Model.CORNER_GROUPS).map(([group, corners]) => `
              <div class="corner-filter-group">
                <span class="corner-filter-group-label">${esc(group)}</span>
                ${corners.map((c) => `
                  <label class="corner-filter-check">
                    <input type="checkbox" class="emp-corner-check" data-id="${emp.id}" value="${esc(c)}" ${Model.employeeCorners(emp).includes(c) ? 'checked' : ''}>
                    ${esc(c)}
                  </label>
                `).join('')}
              </div>
            `).join('')}
          </div>
        </div>
        <div class="specific-off">
          <div class="specific-off-add-row">
            <button type="button" class="btn-open-calendar" data-id="${emp.id}">+ 개인 휴무 날짜 추가</button>
            ${emp.specificOff.length > 0 ? `<button type="button" class="btn-clear-specific-off" data-id="${emp.id}">전체 삭제</button>` : ''}
          </div>
          <div class="date-chips">
            ${emp.specificOff.map((d) => `<span class="chip">${d} (${esc(Model.LEAVE_TYPES[Model.leaveTypeOf(emp, d)])}) <button type="button" class="chip-remove" data-id="${emp.id}" data-date="${d}">×</button></span>`).join('')}
          </div>
        </div>
        ${holidayChoiceHtml}
      </div>
    `;
    }).join('');

    container.innerHTML = `
      <section class="screen">
        <h2>직원 설정</h2>
        <p class="hint">고정 휴무 요일과 이미 승인된 개인 휴무 날짜만 입력하세요. 나머지는 규칙에 따라 자동으로 배정됩니다.</p>
        <div class="employee-search-row">
          <input type="text" id="employee-search" placeholder="이름으로 검색...">
          <button type="button" id="btn-add-employee" class="btn-primary">+ 직원 추가</button>
        </div>
        <div class="corner-filter-row">
          <span class="hint">코너로 조회</span>
          ${Object.entries(Model.CORNER_GROUPS).map(([group, corners]) => `
            <div class="corner-filter-group">
              <span class="corner-filter-group-label">${esc(group)}</span>
              ${corners.map((c) => `
                <label class="corner-filter-check">
                  <input type="checkbox" class="corner-filter" value="${esc(c)}">
                  ${esc(c)}
                </label>
              `).join('')}
            </div>
          `).join('')}
        </div>
        <div id="employee-list">${rows || '<p class="hint">아직 등록된 직원이 없습니다.</p>'}</div>
        <p id="employee-search-empty" class="hint" style="display:none;">검색 결과가 없습니다.</p>
      </section>
    `;

    function applyEmployeeFilter() {
      const term = container.querySelector('#employee-search').value.trim().toLowerCase();
      const checkedCorners = Array.from(container.querySelectorAll('.corner-filter:checked')).map((cb) => cb.value);
      const cards = container.querySelectorAll('.employee-card');
      let visibleCount = 0;
      cards.forEach((card) => {
        const nameInput = card.querySelector('.emp-name');
        const nameMatch = !term || nameInput.value.toLowerCase().includes(term);
        const cardCorners = JSON.parse(card.dataset.corners || '[]');
        const cornerMatch = checkedCorners.length === 0 || checkedCorners.some((c) => cardCorners.includes(c));
        const match = nameMatch && cornerMatch;
        card.style.display = match ? '' : 'none';
        if (match) visibleCount++;
      });
      const emptyMsg = container.querySelector('#employee-search-empty');
      if (emptyMsg) emptyMsg.style.display = ((term || checkedCorners.length > 0) && visibleCount === 0) ? '' : 'none';
    }
    container.querySelector('#employee-search').addEventListener('input', applyEmployeeFilter);
    container.querySelectorAll('.corner-filter').forEach((cb) => cb.addEventListener('change', applyEmployeeFilter));
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
    container.querySelectorAll('.emp-edge-shift-pref').forEach((cb) =>
      cb.addEventListener('change', () => handlers.onUpdateEdgeShiftPreference(cb.dataset.id, cb.checked))
    );
    container.querySelectorAll('.emp-corner-check').forEach((cb) =>
      cb.addEventListener('change', () => {
        const card = cb.closest('.employee-card');
        const checked = Array.from(card.querySelectorAll('.emp-corner-check:checked')).map((c) => c.value);
        card.dataset.corners = JSON.stringify(checked);
        handlers.onUpdateCorners(cb.dataset.id, checked);
        applyEmployeeFilter();
      })
    );
    container.querySelectorAll('.btn-open-calendar').forEach((btn) =>
      btn.addEventListener('click', () => {
        const emp = doc.employees.find((e) => e.id === btn.dataset.id);
        const openToDate = Model.dateISO(doc.month.year, doc.month.month, 1);
        openCustomCalendar(btn, openToDate, (dateStr) => {
          handlers.onAddSpecificOff(btn.dataset.id, dateStr, 'PERSONAL');
        }, (startDate, endDate) => {
          handlers.onAddSpecificOffRange(btn.dataset.id, startDate, endDate, 'PERSONAL');
        }, (selections) => {
          handlers.onApplyDateSelections(btn.dataset.id, selections);
        }, emp ? buildInitialCalendarSelections(emp, doc) : {});
      })
    );
    container.querySelectorAll('.chip-remove').forEach((btn) =>
      btn.addEventListener('click', () => handlers.onRemoveSpecificOff(btn.dataset.id, btn.dataset.date))
    );
    container.querySelectorAll('.btn-clear-specific-off').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (confirm('이 직원의 저장된 휴무 날짜를 전부 삭제할까요? 되돌릴 수 없습니다.')) {
          handlers.onClearSpecificOff(btn.dataset.id);
        }
      })
    );
    container.querySelectorAll('.emp-holiday-choice').forEach((select) =>
      select.addEventListener('change', () =>
        handlers.onSetHolidayChoice(select.dataset.id, select.dataset.date, select.value || null)
      )
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
          <label>목표 휴무일수 (직원 1인당, 이번 달 기준)${ruleBadge('required')}</label>
          <input type="number" id="rule-target-off-days" min="0" step="0.5" value="${rules.targetOffDays != null ? rules.targetOffDays : ''}" placeholder="비우면 이번 달 토/일 일수로 자동 계산">
        </div>
        <p class="hint">비워두면 이번 달 토/일 일수를 자동으로 목표 휴무일수로 씁니다. 값을 입력하면 아래 "기본 최소 근무 인원"이 자동으로 계산되어 반영됩니다. 아래 값을 직접 수정하면 이 자동 계산은 무시됩니다.</p>
        <div class="field-row field-row-combo">
          <label>며칠 이상 연달아 휴무 시${ruleBadge('required')}</label>
          <input type="number" id="rule-long-break-days" min="2" value="${rules.longBreakDays != null ? rules.longBreakDays : ''}" placeholder="예: 4">
          <label class="field-row-combo-label2">그 직원은 최대 며칠까지 근무 가능</label>
          <input type="number" id="rule-extended-work-cap" min="1" value="${rules.extendedWorkCap != null ? rules.extendedWorkCap : ''}" placeholder="예: 5">
        </div>
        <p class="hint">직원이 확정된 휴무(연차 등)를 위 일수 이상 연달아 쓰면, 그 달 전체에서 그 직원은 아래 "최대 연속 근무일수" 대신 이 값까지 허용해요 (휴무 블록 앞뒤에만 국한되지 않고 그 달 전체에 적용). 긴 휴식을 위해 다른 날 하루 더 일하는 걸 감안하는 규칙이에요. 비워두면 적용 안 함.</p>
        ${shiftWarn}
        <p class="hint">최소근무인원/연속근무/오전조/오후조는 문구와 서적이 서로 별도예요. 관리(점장/파트장/영업지원)는 아래 값 대신 매장 공통 기본값을 따로 씁니다(추후 설정).</p>
        <div class="dept-rules-row">
          ${['문구', '서적'].map((dept) => {
            const dr = (rules.deptRules && rules.deptRules[dept]) || {};
            return `
            <div class="dept-rules-col">
              <h3>${dept}</h3>
              <div class="field-row">
                <label>기본 최소 근무 인원${ruleBadge('recommended')}</label>
                <input type="number" class="rule-dept-input" data-dept="${dept}" data-field="minStaffDefault" min="0" value="${dr.minStaffDefault != null ? dr.minStaffDefault : rules.minStaffDefault}">
              </div>
              <div class="field-row">
                <label>최대 연속 근무일수${ruleBadge('required')}</label>
                <input type="number" class="rule-dept-input" data-dept="${dept}" data-field="maxConsecutiveWorkDays" min="1" value="${dr.maxConsecutiveWorkDays != null ? dr.maxConsecutiveWorkDays : rules.maxConsecutiveWorkDays}">
              </div>
              <div class="field-row field-row-combo">
                <label>오전조 최소/최대 인원${ruleBadge('recommended')}</label>
                <input type="number" class="rule-dept-input" data-dept="${dept}" data-field="minMorningStaff" min="0" value="${dr.minMorningStaff != null ? dr.minMorningStaff : (rules.minMorningStaff || 0)}">
                <input type="number" class="rule-dept-input" data-dept="${dept}" data-field="maxMorningStaff" min="0" value="${dr.maxMorningStaff != null ? dr.maxMorningStaff : ''}" placeholder="최소와 동일">
              </div>
              <div class="field-row">
                <label>오후조 최소 인원${ruleBadge('recommended')}</label>
                <input type="number" class="rule-dept-input" data-dept="${dept}" data-field="minAfternoonStaff" min="0" value="${dr.minAfternoonStaff != null ? dr.minAfternoonStaff : (rules.minAfternoonStaff || 0)}">
              </div>
            </div>
          `;
          }).join('')}
        </div>
        <div class="field-row">
          <label><input type="checkbox" id="rule-week-rest" ${rules.minRestPerWeekWindow ? 'checked' : ''}> 매 7일마다 최소 1일 휴무 보장${ruleBadge('required')}</label>
        </div>
        <div class="field-row">
          <label><input type="checkbox" id="rule-back-to-back-off" ${rules.requireBackToBackOff ? 'checked' : ''}> 매달 최소 1회, 이틀 이상 연속 휴무 보장${ruleBadge('required')}</label>
        </div>
        <div class="field-row">
          <label><input type="checkbox" id="rule-avoid-alternating" ${rules.avoidAlternatingShift ? 'checked' : ''}> 퐁당퐁당 방지 (전후전후처럼 매일 근무조 바뀌지 않게 같은 조로 몰아주기)${ruleBadge('recommended')}</label>
        </div>
        <p class="hint">체크하면 최우선으로 같은 조로 몰아주려 하지만, 다른 필수 조건과 겹치면 양보될 수 있어요.</p>
        <p class="hint">최대 근무 인원도 문구와 서적이 서로 별도예요. 비워두면 제한 없음.</p>
        <div class="dept-rules-row">
          ${['문구', '서적'].map((dept) => {
            const dr = (rules.deptRules && rules.deptRules[dept]) || {};
            return `
            <div class="dept-rules-col">
              <h3>${dept}</h3>
              <div class="field-row">
                <label>최대 근무 인원${ruleBadge('recommended')}</label>
                <input type="number" class="rule-dept-input" data-dept="${dept}" data-field="maxStaffDefault" min="0" value="${dr.maxStaffDefault != null ? dr.maxStaffDefault : ''}" placeholder="제한 없음">
              </div>
            </div>
          `;
          }).join('')}
        </div>

        <details class="rule-details">
          <summary>요일별 최소 근무 인원 예외 (선택)${ruleBadge('recommended')}</summary>
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
          <summary>코너별 오전/오후 최소 근무 인원 (선택)${ruleBadge('recommended')}</summary>
          <div class="corner-shift-overrides">
            ${Object.entries(Model.CORNER_GROUPS).flatMap(([group, corners]) => corners).map((corner) => {
              const cornerRule = (rules.minStaffByCorner && rules.minStaffByCorner[corner]) || {};
              return `
                <div class="corner-shift-override-row">
                  <span class="corner-shift-override-name">${esc(corner)}</span>
                  <label class="corner-shift-override-field">오전
                    <input type="number" min="0" class="rule-corner-shift-override" data-corner="${esc(corner)}" data-shift="morning"
                      value="${cornerRule.morning != null ? cornerRule.morning : ''}" placeholder="0">
                  </label>
                  <label class="corner-shift-override-field">오후
                    <input type="number" min="0" class="rule-corner-shift-override" data-corner="${esc(corner)}" data-shift="afternoon"
                      value="${cornerRule.afternoon != null ? cornerRule.afternoon : ''}" placeholder="0">
                  </label>
                </div>
              `;
            }).join('')}
          </div>
        </details>

        <details class="rule-details">
          <summary>특정 날짜 이름표 (꼭 쉬어야하는 날 등) (선택)</summary>
          <div class="date-override-add">
            <input type="date" id="rule-label-date-input">
            <input type="text" id="rule-label-text" placeholder="예: 꼭 쉬어야하는 날">
            <button type="button" id="btn-add-date-label">추가</button>
          </div>
          <div class="date-override-list">
            ${Object.entries(rules.dateLabels || {}).map(([date, label]) => `
              <span class="chip">${date}: ${esc(label)} <button type="button" class="date-label-remove" data-date="${date}">×</button></span>
            `).join('')}
          </div>
        </details>

        <details class="rule-details">
          <summary>특정 날짜 최소 근무 인원 예외 (선택)${ruleBadge('recommended')}</summary>
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

    container.querySelector('#rule-target-off-days').addEventListener('change', (e) => {
      if (e.target.value === '') {
        handlers.onUpdateRule('targetOffDays', null);
        return;
      }
      handlers.onUpdateTargetOffDays(Number(e.target.value));
    });
    container.querySelector('#rule-long-break-days').addEventListener('change', (e) =>
      handlers.onUpdateRule('longBreakDays', e.target.value === '' ? null : Number(e.target.value))
    );
    container.querySelector('#rule-extended-work-cap').addEventListener('change', (e) =>
      handlers.onUpdateRule('extendedWorkCap', e.target.value === '' ? null : Number(e.target.value))
    );
    container.querySelectorAll('.rule-dept-input').forEach((input) =>
      input.addEventListener('change', () =>
        handlers.onUpdateDeptRule(input.dataset.dept, input.dataset.field, input.value === '' ? null : Number(input.value))
      )
    );
    container.querySelector('#rule-avoid-alternating').addEventListener('change', (e) =>
      handlers.onUpdateRule('avoidAlternatingShift', e.target.checked)
    );
    container.querySelector('#rule-week-rest').addEventListener('change', (e) =>
      handlers.onUpdateRule('minRestPerWeekWindow', e.target.checked)
    );
    container.querySelector('#rule-back-to-back-off').addEventListener('change', (e) =>
      handlers.onUpdateRule('requireBackToBackOff', e.target.checked)
    );
    container.querySelectorAll('.rule-weekday-override').forEach((input) =>
      input.addEventListener('change', () =>
        handlers.onUpdateWeekdayOverride(Number(input.dataset.wd), input.value === '' ? null : Number(input.value))
      )
    );
    container.querySelectorAll('.rule-corner-shift-override').forEach((input) =>
      input.addEventListener('change', () =>
        handlers.onUpdateCornerShiftMinStaff(input.dataset.corner, input.dataset.shift, input.value === '' ? null : Number(input.value))
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
    container.querySelector('#btn-add-date-label').addEventListener('click', () => {
      const dateInput = container.querySelector('#rule-label-date-input');
      const textInput = container.querySelector('#rule-label-text');
      if (dateInput.value && textInput.value.trim() !== '') {
        handlers.onUpdateDateLabel(dateInput.value, textInput.value.trim());
        dateInput.value = '';
        textInput.value = '';
      }
    });
    container.querySelectorAll('.date-label-remove').forEach((btn) =>
      btn.addEventListener('click', () => handlers.onUpdateDateLabel(btn.dataset.date, null))
    );
    container.querySelector('#btn-generate').addEventListener('click', () => handlers.onGenerate());
  }

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
          const holiday = Model.holidayName(d);
          const redClass = Model.isRedDay(d) ? ' red-day-col' : '';
          const confClass = conflictDates.has(d) ? ' conflict-col' : '';
          const label = doc.rules.dateLabels && doc.rules.dateLabels[d];
          const labelHtml = label ? `<br><span class="date-label">${esc(label)}</span>` : '';
          const holidayHtml = holiday ? `<br><span class="holiday-label">${esc(holiday)}</span>` : '';
          const conflictAttr = conflictDates.has(d) ? ` data-conflict-date="${d}"` : '';
          return `<th class="${weekendClass}${redClass}${confClass}"${conflictAttr}>${day}<br><span class="wd-label">${Model.WEEKDAY_LABELS[wd]}</span>${holidayHtml}${labelHtml}</th>`;
        }).join('')}
        <th class="total-col">오전</th>
        <th class="total-col">오후</th>
        <th class="total-col">휴무</th>
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
        const redClass = Model.isRedDay(d) ? ' red-day-col' : '';
        const confClass = conflictEmpDay.has(`${emp.id}|${d}`) ? ' conflict-cell' : '';
        const isPersonalLock = cell.status === 'OFF' && cell.source === 'BASE' && emp.specificOff.includes(d);
        const lockClass = isPersonalLock ? ' cell-locked' : '';
        let text = '';
        let statusClass = '';
        if (cell.status === 'OFF') {
          offCount++;
          const leaveType = isPersonalLock ? Model.leaveTypeOf(emp, d) : null;
          text = leaveType && leaveType !== 'PERSONAL' ? esc(Model.LEAVE_TYPES[leaveType]) : '휴';
          statusClass = ' cell-off';
        } else {
          text = cell.shift === 'MORNING' ? '전' : cell.shift === 'AFTERNOON' ? '후' : '';
          statusClass = cell.shift === 'MORNING' ? ' cell-shift-morning' : cell.shift === 'AFTERNOON' ? ' cell-shift-afternoon' : '';
          if (cell.shift === 'MORNING') morningCount++;
          else if (cell.shift === 'AFTERNOON') afternoonCount++;
        }
        // 공휴일 근무 처리(수당/대체휴일)는 직원 설정 화면에서만 바꾼다(사장님 지시: "캘린더에서
        // 바꾸면 안되고 직원관리에서 바꿔야해") — 여기서는 상태만 참고용으로 보여준다.
        const isHolidayWork = cell.status === 'WORK' && !!Model.holidayName(d);
        const holidayChoiceVal = isHolidayWork ? Model.holidayChoiceOf(emp, empSchedule, d) : '';
        const holidayBadge = isHolidayWork
          ? `<span class="holiday-choice-badge${holidayChoiceVal ? ' set' : ''}" title="공휴일 근무: ${holidayChoiceVal === 'SUBSTITUTE' ? '대체휴일' : holidayChoiceVal === 'PAY' ? '수당' : '미정 (직원 설정에서 지정)'}">${holidayChoiceVal === 'SUBSTITUTE' ? '대' : holidayChoiceVal === 'PAY' ? '수' : '?'}</span>`
          : '';
        const halfDayBadge = cell.halfDayLeave
          ? `<span class="halfday-badge" title="${cell.halfDayLeave === 'MORNING' ? '오전반차' : '오후반차'}">반</span>`
          : '';
        const runrunBadge = cell.runrun
          ? `<span class="runrun-badge" title="런런 (2시간 조기퇴근)">런</span>`
          : '';
        return `<td class="cal-cell${statusClass}${weekendClass}${redClass}${confClass}${lockClass}" data-emp="${emp.id}" data-date="${d}" data-status="${cell.status}" data-shift="${cell.shift || ''}" data-locked="${isPersonalLock ? '1' : '0'}">${text}${holidayBadge}${halfDayBadge}${runrunBadge}</td>`;
      }).join('');
      return `<tr class="cal-row" data-corners="${esc(JSON.stringify(Model.employeeCorners(emp)))}"><td class="name-col">${esc(emp.name)}</td>${cells}<td class="total-col">${morningCount}</td><td class="total-col">${afternoonCount}</td><td class="total-col">${offCount}</td></tr>`;
    }).join('');

    const summaryRows = [
      { stat: 'MORNING', label: '오전 인원' },
      { stat: 'AFTERNOON', label: '오후 인원' },
      { stat: 'OFF', label: '휴무 인원' }
    ].map(({ stat, label }) => `
      <tr class="cal-summary-row" data-stat="${stat}">
        <td class="name-col">${label}</td>
        ${dates.map((d) => `<td class="cal-summary-cell" data-date="${d}"></td>`).join('')}
        <td class="total-col"></td><td class="total-col"></td><td class="total-col"></td>
      </tr>
    `).join('');

    container.innerHTML = `
      <section class="screen screen-calendar">
        <h2>결과 캘린더</h2>
        ${banner}
        <div class="corner-filter-row">
          <span class="hint">코너로 조회</span>
          ${Object.entries(Model.CORNER_GROUPS).map(([group, corners]) => `
            <div class="corner-filter-group">
              <label class="corner-filter-check corner-filter-group-check">
                <input type="checkbox" class="cal-corner-group-filter" data-group="${esc(group)}" data-corners="${esc(JSON.stringify(corners))}">
                <span class="corner-filter-group-label">${esc(group)}</span>
              </label>
              ${corners.map((c) => `
                <label class="corner-filter-check">
                  <input type="checkbox" class="cal-corner-filter" value="${esc(c)}">
                  ${esc(c)}
                </label>
              `).join('')}
            </div>
          `).join('')}
        </div>
        <div class="legend">
          <span class="legend-item"><span class="swatch cell-off"></span>휴무</span>
          <span class="legend-item"><span class="swatch cell-shift-morning"></span>오전</span>
          <span class="legend-item"><span class="swatch cell-shift-afternoon"></span>오후</span>
          <span class="legend-item"><span class="swatch red-day-col"></span>빨간날(일요일/공휴일)</span>
          <span class="legend-item">셀을 클릭하면 휴무 → 오전 → 오후 순으로 직접 바꿀 수 있습니다. 고정휴무 칸은 잠금 표시(커서)로 구분됩니다.</span>
        </div>
        <div class="calendar-scroll">
          <table class="calendar-table">
            <thead>${headerRow}</thead>
            <tbody>${bodyRows}</tbody>
            <tfoot>${summaryRows}</tfoot>
          </table>
        </div>
        <div class="calendar-actions">
          <button type="button" id="btn-regenerate" class="btn-primary">다시 계산</button>
          <button type="button" id="btn-reset-manual">수동 수정 초기화</button>
          <button type="button" id="btn-print">인쇄 / PDF로 저장</button>
        </div>
      </section>
    `;

    container.querySelectorAll('th[data-conflict-date]').forEach((th) => {
      th.addEventListener('click', () => {
        const date = th.dataset.conflictDate;
        const messages = doc.conflicts.filter((c) => c.date === date).map((c) => c.message);
        openConflictPopup(th, date, messages);
      });
    });
    container.querySelectorAll('.cal-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        if (cell.dataset.locked === '1') return;
        handlers.onToggleCell(cell.dataset.emp, cell.dataset.date, cell.dataset.status, cell.dataset.shift || null);
      });
    });
    function updateDateSummary() {
      const visibleRows = Array.from(container.querySelectorAll('.cal-row')).filter((row) => row.style.display !== 'none');
      const counts = { OFF: {}, MORNING: {}, AFTERNOON: {} };
      dates.forEach((d) => { counts.OFF[d] = 0; counts.MORNING[d] = 0; counts.AFTERNOON[d] = 0; });
      visibleRows.forEach((row) => {
        row.querySelectorAll('.cal-cell').forEach((cell) => {
          const d = cell.dataset.date;
          if (cell.dataset.status === 'OFF') counts.OFF[d]++;
          else if (cell.dataset.shift === 'MORNING') counts.MORNING[d]++;
          else if (cell.dataset.shift === 'AFTERNOON') counts.AFTERNOON[d]++;
        });
      });
      container.querySelectorAll('.cal-summary-row').forEach((row) => {
        const stat = row.dataset.stat;
        row.querySelectorAll('.cal-summary-cell').forEach((cell) => {
          cell.textContent = counts[stat][cell.dataset.date];
        });
      });
    }
    function applyCornerFilter() {
      const checkedCorners = Array.from(container.querySelectorAll('.cal-corner-filter:checked')).map((c) => c.value);
      container.querySelectorAll('.cal-row').forEach((row) => {
        const rowCorners = JSON.parse(row.dataset.corners || '[]');
        row.style.display = (checkedCorners.length === 0 || checkedCorners.some((c) => rowCorners.includes(c))) ? '' : 'none';
      });
      updateDateSummary();
    }
    updateDateSummary();
    container.querySelectorAll('.cal-corner-group-filter').forEach((groupCb) => groupCb.addEventListener('change', () => {
      const corners = JSON.parse(groupCb.dataset.corners || '[]');
      container.querySelectorAll('.cal-corner-filter').forEach((cb) => {
        if (corners.includes(cb.value)) cb.checked = groupCb.checked;
      });
      applyCornerFilter();
    }));
    container.querySelectorAll('.cal-corner-filter').forEach((cb) => cb.addEventListener('change', () => {
      const group = cb.closest('.corner-filter-group');
      if (group) {
        const groupCb = group.querySelector('.cal-corner-group-filter');
        const childBoxes = Array.from(group.querySelectorAll('.cal-corner-filter'));
        groupCb.checked = childBoxes.length > 0 && childBoxes.every((b) => b.checked);
      }
      applyCornerFilter();
    }));
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
